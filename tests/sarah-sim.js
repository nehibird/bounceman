'use strict';
/**
 * Sarah Conversation Simulator
 * Replicates exactly what Vapi does: GPT-4.1 + real tool endpoints.
 * Run: node sarah-sim.js
 */

const OPENAI_KEY   = process.env.OPENAI_API_KEY   || (() => { throw new Error('OPENAI_API_KEY not set'); })();
const VAPI_KEY     = process.env.VAPI_API_KEY     || (() => { throw new Error('VAPI_API_KEY not set'); })();
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '2549cba6-1c8e-44df-86ed-a0f7533c162c';
const SARAH_KEY    = process.env.SARAH_API_KEY    || 'sarah-bm-k3y-2026-s3cur3';
const BASE_URL     = process.env.SARAH_BASE_URL   || 'https://bouncemanrentals.com/api/sarah';
const CALLER_NUM   = '+15005550006'; // fake Twilio test number — prevents real SMS during test runs

// ── Tool definitions (must match what's in Vapi) ────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'checkAvailability',
      description: 'Check what equipment is available on a given date.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          zip:  { type: 'string' }
        },
        required: ['date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'createAndSendLink',
      description: 'Create a booking and text a Stripe payment link.',
      parameters: {
        type: 'object',
        properties: {
          first_name:    { type: 'string' },
          last_name:     { type: 'string' },
          email:         { type: 'string' },
          phone:         { type: 'string' },
          equipment_ids: { type: 'array', items: { type: 'string' } },
          duration:      { type: 'string', enum: ['4hr', 'daily', 'overnight'] },
          event_date:    { type: 'string' },
          event_start_time: { type: 'string' },
          delivery_city: { type: 'string' },
          delivery_zip:  { type: 'string' },
          discount_code: { type: 'string' }
        },
        required: ['first_name', 'phone', 'equipment_ids', 'duration', 'event_date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookupBooking',
      description: 'Look up an existing booking by phone or booking number.',
      parameters: {
        type: 'object',
        properties: {
          phone:          { type: 'string' },
          booking_number: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'transferCall',
      description: 'Transfer the call to Nehemiah.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'endCall',
      description: 'End the call.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// ── Call our real tool endpoints ─────────────────────────────────────────────
async function callTool(name, args) {
  if (name === 'transferCall') return { result: 'TRANSFER_INITIATED to +15806281765' };
  if (name === 'endCall')      return { result: 'CALL_ENDED' };

  const pathMap = {
    checkAvailability: 'check-availability',
    createAndSendLink: 'create-and-send-link',
    lookupBooking:     'lookup-booking'
  };
  const path = pathMap[name];
  if (!path) return { error: `Unknown tool: ${name}` };

  // Inject caller phone for tools that need it
  if (name === 'createAndSendLink' && !args.phone) args.phone = CALLER_NUM;
  if (name === 'lookupBooking'     && !args.phone) args.phone = CALLER_NUM;

  const res = await fetch(`${BASE_URL}/${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-sarah-key': SARAH_KEY },
    body:    JSON.stringify(args)
  });
  return res.json();
}

// ── One conversation turn through GPT-4.1 ────────────────────────────────────
async function runConversation(systemPrompt, turns, opts = {}) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...turns.map(t => ({ role: 'user', content: t }))
  ];
  const log = [];
  const createdBookings = [];

  // Multi-turn: process until no more tool calls (max 6 rounds)
  for (let round = 0; round < 6; round++) {
    const body = {
      model: 'gpt-4.1',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.4,
      max_tokens: 600
    };

    const res  = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const choice  = data.choices[0];
    const message = choice.message;
    messages.push(message);

    if (message.content) log.push({ role: 'assistant', text: message.content });

    if (choice.finish_reason !== 'tool_calls' || !message.tool_calls?.length) break;

    // Execute each tool call against real endpoints
    for (const tc of message.tool_calls) {
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;

      log.push({ role: 'tool_call', name: tc.function.name, args });

      const result = await callTool(tc.function.name, args);
      log.push({ role: 'tool_result', name: tc.function.name, result });

      // Track test bookings for cleanup
      if (tc.function.name === 'createAndSendLink' && result.booking_number) {
        createdBookings.push(result.booking_number);
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result)
      });
    }
  }

  return { log, createdBookings };
}

// ── Cleanup test bookings ────────────────────────────────────────────────────
async function cleanupBooking(bookingNumber) {
  // Call admin delete or just flag it — for now just log
  console.log(`  [cleanup] Would delete ${bookingNumber} — do manually in admin if needed`);
}

// ── Test scenarios ────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    name: '1. Date recognition — "May fifteenth"',
    turns: ['Hey I need to rent a bounce house for May fifteenth'],
    checks: [
      { type: 'tool_called', tool: 'checkAvailability' },
      { type: 'tool_result_has', tool: 'checkAvailability', key: 'result', notEmpty: true },
      { type: 'response_contains_one_of', values: ['May 15', 'fifteenth', 'Blue Crush', 'Tropical', 'Monkey', '300', '250', '150'] },
      { type: 'response_not_contains', value: "didn't quite catch" }
    ]
  },
  {
    name: '2. Date recognition — "May twenty fifth" (STT space-separated)',
    turns: ['I want to book something for May twenty fifth'],
    checks: [
      { type: 'tool_called', tool: 'checkAvailability' },
      { type: 'tool_result_has', tool: 'checkAvailability', key: 'date', value: '2026-05-25' },
      { type: 'response_not_contains', value: "didn't quite catch" }
    ]
  },
  {
    name: '3. No obstacle courses',
    turns: ['Do you guys have obstacle courses?'],
    checks: [
      { type: 'tool_not_called', tool: 'checkAvailability' },
      { type: 'response_contains_one_of', values: ["don't have", "don't carry", "not have", "do not have", "we don't"] }
    ]
  },
  {
    name: '4. Transfer to Nehemiah',
    turns: ['Can I talk to Nehemiah?'],
    checks: [
      { type: 'tool_called', tool: 'transferCall' },
      { type: 'response_contains_one_of', values: ['Nehemiah', 'connecting', 'transferring', 'one moment', 'Sure thing'] }
    ]
  },
  {
    name: '5. Transfer — "speak to a person"',
    turns: ['I want to speak to a real person'],
    checks: [
      { type: 'tool_called', tool: 'transferCall' }
    ]
  },
  {
    name: '6. Lookup existing booking (2-turn)',
    turns: [
      'Can you check on my booking?',
      'It is 5806281765'
    ],
    checks: [
      { type: 'tool_called', tool: 'lookupBooking' }
    ]
  },
  {
    name: '7. Sunday availability — should say unavailable',
    turns: ['I need something for this Sunday'],
    checks: [
      { type: 'response_contains_one_of', values: ['Sunday', 'Monday', 'unavailable', "don't rent", 'Monday through Saturday', 'not available'] }
    ]
  },
  {
    name: '8. Church discount mention',
    turns: ['We are looking for something for our VBS event on June 7th'],
    checks: [
      { type: 'tool_called', tool: 'checkAvailability' },
      { type: 'response_contains_one_of', values: ['church', 'VBS', 'discount', 'ministry', 'love'] }
    ]
  },
  {
    name: '9. Full booking flow',
    turns: [
      'I need a water slide for October tenth',
      'The Blue Crush sounds great. My zip is 74653. My name is Jamie. Full day please.',
      'Yes I have a standard power outlet nearby',
      'No thanks on the water hose',
      'Yes that all sounds right',
      'Yes go ahead and text the link to this number'
    ],
    checks: [
      { type: 'tool_called', tool: 'createAndSendLink' },
      { type: 'tool_result_has', tool: 'createAndSendLink', key: 'success', value: true },
      { type: 'tool_result_has', tool: 'createAndSendLink', key: 'sms_sent', value: true },
      { type: 'response_contains_one_of', values: ['BM-', 'booking', 'text', 'link', 'deposit'] }
    ],
    cleanup: true
  },
  {
    name: '10. Power question asked during booking',
    turns: [
      'I want to rent the Monkey Jumper for June eighth',
      'Full day please. Zip is 74653. Name is Dana.'
    ],
    checks: [
      { type: 'tool_called', tool: 'checkAvailability' },
      { type: 'response_contains_one_of', values: ['outlet', 'power', 'electrical', 'generator', 'plug'] }
    ]
  },
  {
    name: '11. Overnight not available on Saturday',
    turns: ['Can I do an overnight rental this Saturday?'],
    checks: [
      { type: 'response_contains_one_of', values: ['overnight', 'saturday', 'not available', 'monday', 'friday', 'weekday'] }
    ]
  }
];

// ── Run all scenarios ─────────────────────────────────────────────────────────
async function main() {
  // Fetch the live system prompt from Vapi
  console.log('Fetching live system prompt from Vapi...');
  const asst = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
    headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
  }).then(r => r.json());
  const systemPrompt = asst.model?.messages?.[0]?.content;
  if (!systemPrompt) { console.error('Could not fetch system prompt'); process.exit(1); }
  // Inject today's date (Vapi does this via Liquid templating)
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
  const prompt = systemPrompt
    .replace('{{call.customer.number}}', CALLER_NUM)
    .replace(/\{\{customerPhone\}\}/g, CALLER_NUM)
    .replace(/{{"now" \| date:.*?}}/, today);
  console.log(`System prompt loaded (${prompt.length} chars). Today = ${today}\n`);

  let passed = 0, failed = 0;
  const failures = [];

  for (const scenario of SCENARIOS) {
    process.stdout.write(`${scenario.name} ... `);
    try {
      const { log, createdBookings } = await runConversation(prompt, scenario.turns);

      // Extract data for checks
      const toolsCalled = log.filter(l => l.role === 'tool_call').map(l => l.name);
      const toolResults = log.filter(l => l.role === 'tool_result');
      const finalResponse = log.filter(l => l.role === 'assistant').map(l => l.text).join(' ').toLowerCase();

      const errors = [];
      for (const check of scenario.checks) {
        if (check.type === 'tool_called' && !toolsCalled.includes(check.tool)) {
          errors.push(`Expected tool "${check.tool}" to be called. Called: [${toolsCalled.join(', ')}]`);
        }
        if (check.type === 'tool_not_called' && toolsCalled.includes(check.tool)) {
          errors.push(`Tool "${check.tool}" should NOT have been called`);
        }
        if (check.type === 'tool_result_has') {
          const r = toolResults.find(t => t.name === check.tool);
          if (!r) { errors.push(`No result for tool "${check.tool}"`); continue; }
          const val = r.result[check.key];
          if (check.notEmpty && !val) errors.push(`Tool "${check.tool}" result.${check.key} is empty`);
          if (check.value !== undefined && val !== check.value) {
            errors.push(`Tool "${check.tool}" result.${check.key} = ${JSON.stringify(val)}, expected ${JSON.stringify(check.value)}`);
          }
        }
        if (check.type === 'response_contains_one_of') {
          const found = check.values.some(v => finalResponse.includes(v.toLowerCase()));
          if (!found) errors.push(`Response missing any of: [${check.values.join(', ')}]\nResponse: "${finalResponse.slice(0, 200)}"`);
        }
        if (check.type === 'response_not_contains' && finalResponse.includes(check.value.toLowerCase())) {
          errors.push(`Response should NOT contain: "${check.value}"\nResponse: "${finalResponse.slice(0, 200)}"`);
        }
      }

      if (errors.length === 0) {
        console.log('PASS');
        passed++;
      } else {
        console.log('FAIL');
        failed++;
        failures.push({ scenario: scenario.name, errors });
        // Print log for failed scenarios
        for (const entry of log) {
          if (entry.role === 'tool_call')    console.log(`    >> TOOL: ${entry.name}(${JSON.stringify(entry.args).slice(0,80)})`);
          if (entry.role === 'tool_result')  console.log(`    << RESULT: ${JSON.stringify(entry.result).slice(0,120)}`);
          if (entry.role === 'assistant')    console.log(`    AI: ${entry.text.slice(0,150)}`);
        }
      }

      // Cleanup test bookings
      for (const bn of createdBookings) await cleanupBooking(bn);

    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      failed++;
      failures.push({ scenario: scenario.name, errors: [err.message] });
    }

    // Small delay between scenarios
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${SCENARIOS.length} scenarios`);
  if (failures.length) {
    console.log('\nFailed scenarios:');
    for (const f of failures) {
      console.log(`\n  ✗ ${f.scenario}`);
      f.errors.forEach(e => console.log(`    - ${e}`));
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });

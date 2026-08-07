// Sarah must NOT auto-reply to two things that arrive looking like messages.
//
// 1. Tapbacks. Dawn Spaulding tapped "Love" on a text; her phone sent us
//    Loved "Perfect! Thanks for letting us know…" and Sarah replied to it, commenting
//    on the tone of her own message in the third person, to the customer.
// 2. Conversation closers. Paige Legg said "Thank you" and Sarah sent another text.
//
// Run from the app root: node tests/sarah-noreply.test.js
const { isReaction, isConversationCloser } = require('../services/sarah-sms');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  got ${got}, want ${want}`));
}

console.log('Tapbacks — must be ignored:');
t('Loved "…" (the real one)',
  isReaction('Loved "Perfect! Thanks for letting us know - sounds like we\'re all set for setup on Saturday the 15th."'), true);
t('Liked "…"',          isReaction('Liked "We\'ll see you Saturday"'), true);
t('Disliked "…"',       isReaction('Disliked "Your balance is due"'), true);
t('Laughed at "…"',     isReaction('Laughed at "the crew will be there bright and early"'), true);
t('Emphasized "…"',     isReaction('Emphasized "9 AM"'), true);
t('Questioned "…"',     isReaction('Questioned "we anchor with stakes"'), true);
t('curly quotes',       isReaction('Loved “Perfect! Thanks for letting us know”'), true);
t('RCS Reacted 👍 to',  isReaction('Reacted 👍 to "We\'ll see you Saturday"'), true);

console.log('Real messages — must NOT be mistaken for tapbacks:');
t('loved the slide',    isReaction('We loved the slide last year, booking again!'), false);
t('liked as a verb',    isReaction('I liked the blue one better'), false);
t('normal question',    isReaction('What time are you coming?'), false);
t('empty',              isReaction(''), false);

console.log('Conversation closers — must be ignored:');
t('Thank you (the real one)', isConversationCloser('Thank you'), true);
t('Thanks!',            isConversationCloser('Thanks!'), true);
t('thank you so much 🎉', isConversationCloser('thank you so much 🎉'), true);
t('Ok',                 isConversationCloser('Ok'), true);
t('Sounds good',        isConversationCloser('Sounds good'), true);
t('Got it',             isConversationCloser('Got it.'), true);
t('bare thumbs up',     isConversationCloser('👍'), true);
t('Perfect',            isConversationCloser('Perfect'), true);

console.log('Must still get a reply:');
t('thanks + question',  isConversationCloser('Thanks, can you come at 10 instead?'), false);
t('any question mark',  isConversationCloser('ok?'), false);
t('thanks + content',   isConversationCloser('Thanks — one more thing, we moved to a new address'), false);
t('real enquiry',       isConversationCloser('Do you have anything for the 15th'), false);
t('one word booking',   isConversationCloser('Yes'), false);
t('empty string',       isConversationCloser(''), false);
t('long sentence',      isConversationCloser('Not to our knowledge, we have put up bouncy houses here before'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Oklahoma Sales Tax Rates — Complete State Coverage
// Source: Oklahoma Tax Commission "Rates and Codes for Sales, Use, and Lodging Tax"
// Effective January through March 2026 (Q1 2026)
// State tax rate: 4.5% (effective May 1, 1990)
// Total = State (4.5%) + County + City

// Rates reconciled against the OTC 'Rates and Codes for Sales, Use, and Lodging Tax'
// COPO chart, rates effective July-September 2026 (chart updated 2026-05-29), on
// 2026-08-10. 14 rates corrected. Re-check each quarter - OTC republishes the chart
// and city rates do move.
const STATE_RATE = 0.045;

// All 77 Oklahoma counties and their sales/use tax rates
const COUNTY_RATES = {
  'ADAIR': 0.0175, 'ALFALFA': 0.02, 'ATOKA': 0.02, 'BEAVER': 0.02,
  'BECKHAM': 0.0035, 'BLAINE': 0.00875, 'BRYAN': 0.005, 'CADDO': 0.015,
  'CANADIAN': 0.0035, 'CARTER': 0.00875, 'CHEROKEE': 0.0175, 'CHOCTAW': 0.02,
  'CIMARRON': 0.02, 'CLEVELAND': 0.00125, 'COAL': 0.02, 'COMANCHE': 0.00375,
  'COTTON': 0.03, 'CRAIG': 0.02, 'CREEK': 0.01167, 'CUSTER': 0.005,
  'DELAWARE': 0.017, 'DEWEY': 0.0175, 'ELLIS': 0.02, 'GARFIELD': 0.0035,
  'GARVIN': 0.0075, 'GRADY': 0.0075, 'GRANT': 0.0125, 'GREER': 0.02,
  'HARMON': 0.04, 'HARPER': 0.02, 'HASKELL': 0.02, 'HUGHES': 0.01,
  'JACKSON': 0.01125, 'JEFFERSON': 0.02, 'JOHNSTON': 0.02, 'KAY': 0.0125,
  'KINGFISHER': 0.0125, 'KIOWA': 0.03, 'LATIMER': 0.0125, 'LEFLORE': 0.023,
  'LINCOLN': 0.01, 'LOGAN': 0.0075, 'LOVE': 0.025, 'MCCLAIN': 0.005,
  'MCCURTAIN': 0.0175, 'MCINTOSH': 0.02, 'MAJOR': 0.01406, 'MARSHALL': 0.02,
  'MAYES': 0.01375, 'MURRAY': 0.02, 'MUSKOGEE': 0.01499, 'NOBLE': 0.015,
  'NOWATA': 0.02, 'OKFUSKEE': 0.02, 'OKLAHOMA': 0.00, 'OKMULGEE': 0.01583,
  'OSAGE': 0.0125, 'OTTAWA': 0.0135, 'PAWNEE': 0.02, 'PAYNE': 0.00813,
  'PITTSBURG': 0.015, 'PONTOTOC': 0.00875, 'POTTAWATOMIE': 0.01495,
  'PUSHMATAHA': 0.02, 'ROGER MILLS': 0.015, 'ROGERS': 0.015,
  'SEMINOLE': 0.0125, 'SEQUOYAH': 0.01417, 'STEPHENS': 0.007,
  'TEXAS': 0.0145, 'TILLMAN': 0.03, 'TULSA': 0.003667, 'WAGONER': 0.0155,
  'WASHINGTON': 0.01, 'WASHITA': 0.02, 'WOODS': 0.005, 'WOODWARD': 0.009
};

// All Oklahoma cities with sales/use tax, from the Q1 2026 rate chart
// Rate shown is CITY-ONLY rate (add state + county for total)
const CITY_RATES = {
  'ACHILLE': 0.03, 'ADA': 0.04, 'ADAIR': 0.04, 'ADDINGTON': 0.02,
  'AFTON': 0.035, 'AGRA': 0.04, 'ALDERSON': 0.02, 'ALEX': 0.03,
  'ALINE': 0.03, 'ALLEN': 0.03, 'ALTUS': 0.04125,
  'ALVA': 0.0425, 'AMBER': 0.04, 'AMES': 0.03, 'ANADARKO': 0.035,
  'ANTLERS': 0.035, 'APACHE': 0.04, 'ARAPAHO': 0.03, 'ARCADIA': 0.04,
  'ARDMORE': 0.0375, 'ARKOMA': 0.03, 'ARNETT': 0.04, 'ASHER': 0.04,
  'ATOKA': 0.04, 'ATWOOD': 0.02, 'AVANT': 0.02, 'BARNSDALL': 0.04,
  'BARTLESVILLE': 0.034, 'BEGGS': 0.045, 'BENNINGTON': 0.04,
  'BERNICE': 0.035, 'BESSIE': 0.02, 'BETHANY': 0.04,
  'BETHEL ACRES': 0.025, 'BIG CABIN': 0.025, 'BILLINGS': 0.04,
  'BINGER': 0.04, 'BIXBY': 0.0405, 'BLACKWELL': 0.05,
  'BLAIR': 0.03, 'BLANCHARD': 0.05, 'BLUEJACKET': 0.02,
  'BOISE CITY': 0.03, 'BOKCHITO': 0.04, 'BOKOSHE': 0.04,
  'BOLEY': 0.05, 'BOSWELL': 0.03, 'BOWLEGS': 0.03, 'BOYNTON': 0.02,
  'BRADLEY': 0.03, 'BRAGGS': 0.03, 'BRAMAN': 0.04, 'BRAY': 0.01,
  'BRIDGEPORT': 0.03, 'BRISTOW': 0.05, 'BROKEN ARROW': 0.0355,
  'BROKEN BOW': 0.04, 'BUFFALO': 0.03, 'BURBANK': 0.02,
  'BURLINGTON': 0.01, 'BURNS FLAT': 0.04, 'BUTLER': 0.03,
  'BYARS': 0.04, 'BYNG': 0.04, 'BYRON': 0.02, 'CACHE': 0.0375,
  'CADDO': 0.04, 'CALERA': 0.04, 'CALUMET': 0.04,
  'CALVIN': 0.04, 'CAMERON': 0.02, 'CANADIAN': 0.045,
  'CANEY': 0.02, 'CANTON': 0.04, 'CANUTE': 0.04,
  'CARLTON LANDING': 0.03, 'CARMEN': 0.035, 'CARNEGIE': 0.04,
  'CARNEY': 0.04, 'CARTER': 0.04, 'CASHION': 0.04,
  'CASTLE': 0.03, 'CATOOSA': 0.0325, 'CEDAR VALLEY': 0.0025,
  'CEMENT': 0.035, 'CENTRAL HIGH': 0.02, 'CHANDLER': 0.04,
  'CHATTANOOGA': 0.03, 'CHECOTAH': 0.04, 'CHELSEA': 0.03,
  'CHEROKEE': 0.0325, 'CHEYENNE': 0.03, 'CHICKASHA': 0.0425,
  'CHOCTAW': 0.0525, 'CHOUTEAU': 0.045, 'CIMARRON CITY': 0.02,
  'CLAREMORE': 0.04, 'CLAYTON': 0.04, 'CLEARVIEW': 0.04,
  'CLEO SPRINGS': 0.05, 'CLEVELAND': 0.035, 'CLINTON': 0.045,
  'COALGATE': 0.03, 'COLBERT': 0.04, 'COLCORD': 0.04,
  'COLE': 0.04, 'COLLINSVILLE': 0.048, 'COLONY': 0.02,
  'COMANCHE': 0.04, 'COMMERCE': 0.05, 'COPAN': 0.03,
  'CORDELL': 0.04, 'CORN': 0.02, 'CORNISH': 0.02,
  'COUNCIL HILL': 0.02, 'COVINGTON': 0.04, 'COWETA': 0.04,
  'COYLE': 0.03, 'CRESCENT': 0.03, 'CROMWELL': 0.03,
  'CROWDER': 0.04, 'CUSHING': 0.04, 'CUSTER CITY': 0.04,
  'CYRIL': 0.04, 'DAVENPORT': 0.04, 'DAVIDSON': 0.04,
  'DAVIS': 0.03, 'DEER CREEK': 0.03, 'DEL CITY': 0.045,
  'DELAWARE': 0.02, 'DEPEW': 0.04, 'DEWAR': 0.04,
  'DEWEY': 0.034, 'DIBBLE': 0.05, 'DICKSON': 0.04,
  'DILL CITY': 0.03, 'DISNEY': 0.03875, 'DOUGHERTY': 0.02,
  'DOUGLAS': 0.02, 'DOVER': 0.04, 'DRUMMOND': 0.03,
  'DRUMRIGHT': 0.045, 'DUNCAN': 0.035, 'DURANT': 0.04375,
  'DUSTIN': 0.04, 'EAKLY': 0.03, 'EARLSBORO': 0.03,
  'EAST DUKE': 0.035, 'EDMOND': 0.0375, 'EL RENO': 0.04,
  'ELDORADO': 0.02, 'ELGIN': 0.04, 'ELK CITY': 0.045,
  'ELMORE CITY': 0.04, 'ENID': 0.0425, 'ERICK': 0.05,
  'EUFAULA': 0.035, 'FAIRFAX': 0.03, 'FAIRLAND': 0.03,
  'FAIRMONT': 0.03, 'FAIRVIEW': 0.04, 'FANSHAWE': 0.03,
  'FARGO': 0.03, 'FAXON': 0.02, 'FLETCHER': 0.04,
  'FOREST PARK': 0.03, 'FORGAN': 0.03, 'FORT COBB': 0.04,
  'FORT COFFEE': 0.03, 'FORT GIBSON': 0.045, 'FORT SUPPLY': 0.03,
  'FORT TOWSON': 0.035, 'FOSS': 0.04, 'FOSTER': 0.04,
  'FOYIL': 0.04, 'FRANCIS': 0.04, 'FREDERICK': 0.025,
  'FREEDOM': 0.02, 'GAGE': 0.03, 'GANS': 0.02,
  'GARBER': 0.04, 'GARVIN': 0.03, 'GATE': 0.02,
  'GEARY': 0.035, 'GENE AUTRY': 0.03, 'GERONIMO': 0.03,
  'GERTY': 0.02, 'GLENCOE': 0.04662, 'GLENPOOL': 0.051,
  'GOLDSBY': 0.035, 'GOLTRY': 0.03, 'GOODWELL': 0.03,
  'GORE': 0.04, 'GOTEBO': 0.04, 'GOULD': 0.02,
  'GRACEMONT': 0.04, 'GRANDFIELD': 0.03, 'GRANITE': 0.03,
  'GRAYSON': 0.04, 'GREENFIELD': 0.03, 'GROVE': 0.04,
  'GUTHRIE': 0.0375, 'GUYMON': 0.04, 'HAILEYVILLE': 0.03,
  'HALLETT': 0.045, 'HAMMON': 0.03, 'HANNA': 0.04,
  'HARDESTY': 0.04, 'HARRAH': 0.04, 'HARTSHORNE': 0.0375,
  'HASKELL': 0.0435, 'HASTINGS': 0.03, 'HAWORTH': 0.035,
  'HEALDTON': 0.04, 'HEAVENER': 0.035, 'HELENA': 0.03,
  'HENNESSEY': 0.04, 'HENRYETTA': 0.04, 'HILLSDALE': 0.01,
  'HINTON': 0.0375, 'HITCHCOCK': 0.03, 'HOBART': 0.04,
  'HOCHATOWN': 0.03, 'HOLDENVILLE': 0.05, 'HOLLIS': 0.03,
  'HOLLISTER': 0.03, 'HOMINY': 0.035, 'HOOKER': 0.04,
  'HOWE': 0.03, 'HUGO': 0.035, 'HULBERT': 0.04,
  'HUNTER': 0.04, 'HYDRO': 0.045, 'IDABEL': 0.04,
  'INDIAHOMA': 0.04, 'INDIANOLA': 0.03, 'INOLA': 0.045,
  'JAY': 0.04, 'JENKS': 0.0355, 'JENNINGS': 0.04,
  'JET': 0.03, 'JONES': 0.05, 'KANSAS': 0.04,
  'KAW CITY': 0.045, 'KELLYVILLE': 0.035, 'KENDRICK': 0.04,
  'KENEFIC': 0.03, 'KEOTA': 0.035, 'KETCHUM': 0.03,
  'KEYES': 0.02, 'KIEFER': 0.04, 'KINGFISHER': 0.035,
  'KINGSTON': 0.03, 'KINTA': 0.025, 'KIOWA': 0.05,
  'KNOWLES': 0.02, 'KONAWA': 0.04, 'KREBS': 0.04,
  'KREMLIN': 0.03, 'LAHOMA': 0.045, 'LAKE ALUMA': 0.0275,
  'LAMAR': 0.03, 'LAMONT': 0.05, 'LANGLEY': 0.03,
  'LANGSTON': 0.04, 'LAVERNE': 0.0325, 'LAWTON': 0.04125,
  'LEEDEY': 0.03, 'LEFLORE': 0.01, 'LEHIGH': 0.02,
  'LENEPAH': 0.02, 'LEXINGTON': 0.04, 'LINDSAY': 0.04,
  'LOCO': 0.03, 'LOCUST GROVE': 0.05, 'LONE CHIMNEY': 0.03,
  'LONE GROVE': 0.04, 'LONE WOLF': 0.03, 'LONGDALE': 0.03,
  'LOOKEBA': 0.03, 'LOYAL': 0.04, 'LUTHER': 0.04,
  'MACOMB': 0.03, 'MADILL': 0.03, 'MANCHESTER': 0.01,
  'MANGUM': 0.03, 'MANITOU': 0.03, 'MANNFORD': 0.035,
  'MANNSVILLE': 0.03, 'MARAMEC': 0.03, 'MARBLE CITY': 0.03,
  'MARIETTA': 0.03, 'MARLAND': 0.03, 'MARLOW': 0.035,
  'MARSHALL': 0.04, 'MAUD': 0.04, 'MAY': 0.02,
  'MAYSVILLE': 0.04, 'MCALESTER': 0.04, 'MCCURTAIN': 0.035,
  'MCLOUD': 0.04, 'MEAD': 0.02, 'MEDFORD': 0.04,
  'MEDICINE PARK': 0.04125, 'MEEKER': 0.04, 'MENO': 0.03,
  'MERIDIAN': 0.02, 'MIAMI': 0.03650, 'MIDWEST CITY': 0.046,
  'MILBURN': 0.02, 'MILL CREEK': 0.035, 'MILLERTON': 0.03,
  'MINCO': 0.04, 'MOORE': 0.03875, 'MOORELAND': 0.04,
  'MORRIS': 0.04, 'MORRISON': 0.04, 'MOUNDS': 0.04,
  'MOUNTAIN PARK': 0.03, 'MOUNTAIN VIEW': 0.04,
  'MULDROW': 0.035, 'MULHALL': 0.03, 'MUSKOGEE': 0.04,
  'MUSTANG': 0.04, 'NASH': 0.03, 'NEW ALLUWE': 0.02,
  'NEWCASTLE': 0.04, 'NEWKIRK': 0.04, 'NICHOLS HILLS': 0.04,
  'NICOMA PARK': 0.05, 'NINNEKAH': 0.03, 'NOBLE': 0.04125,
  'NORGE': 0.01, 'NORMAN': 0.04125, 'NORTH ENID': 0.04,
  'NORTH MIAMI': 0.035, 'NOWATA': 0.04, 'OAKLAND': 0.02,
  'OAKS': 0.03, 'OCHELATA': 0.03, 'OILTON': 0.05,
  'OKARCHE': 0.045, 'OKAY': 0.04, 'OKEENE': 0.05250,
  'OKEMAH': 0.035, 'OKLAHOMA CITY': 0.04125,
  'OKMULGEE': 0.04, 'OKTAHA': 0.04, 'OLUSTEE': 0.01,
  'OOLOGAH': 0.03, 'ORLANDO': 0.04, 'OWASSO': 0.0405,
  'PADEN': 0.03, 'PANAMA': 0.03, 'PARADISE HILL': 0.03,
  'PAOLI': 0.03, 'PAULS VALLEY': 0.045, 'PAWHUSKA': 0.04,
  'PAWNEE': 0.035, 'PENSACOLA': 0.03, 'PEORIA': 0.01,
  'PERKINS': 0.03875, 'PERRY': 0.04250, 'PICHER': 0.0,
  'PIEDMONT': 0.05, 'PINK': 0.03, 'PITTSBURG': 0.03,
  'POCASSET': 0.015, 'POCOLA': 0.04, 'PONCA CITY': 0.03833,
  'POND CREEK': 0.04, 'PORTER': 0.04, 'PORUM': 0.05,
  'POTEAU': 0.03, 'PRAGUE': 0.04, 'PRUE': 0.03,
  'PRYOR': 0.04, 'PURCELL': 0.05, 'QUINTON': 0.03,
  'RALSTON': 0.03, 'RAMONA': 0.02, 'RATLIFF CITY': 0.035,
  'RATTAN': 0.035, 'RAVIA': 0.03, 'RED OAK': 0.03,
  'RED ROCK': 0.05, 'RENFROW': 0.04, 'RENTIESVILLE': 0.04,
  'REYDON': 0.02, 'RINGLING': 0.025, 'RINGWOOD': 0.03,
  'RIPLEY': 0.03, 'ROCK ISLAND': 0.015, 'ROCKY': 0.04,
  'ROFF': 0.045, 'ROLAND': 0.04, 'ROOSEVELT': 0.03,
  'RUSH SPRINGS': 0.045, 'RYAN': 0.03, 'SALINA': 0.04,
  'SALLISAW': 0.04, 'SAND SPRINGS': 0.0405, 'SAPULPA': 0.04,
  'SASAKWA': 0.04, 'SAVANNA': 0.05, 'SAWYER': 0.01,
  'SAYRE': 0.04, 'SCHULTER': 0.005, 'SEILING': 0.04,
  'SEMINOLE': 0.04125, 'SENTINEL': 0.03, 'SHADY POINT': 0.035,
  'SHAMROCK': 0.03, 'SHATTUCK': 0.04, 'SHAWNEE': 0.04,
  'SHIDLER': 0.02, 'SKIATOOK': 0.045, 'SLAUGHTERVILLE': 0.02,
  'SLICK': 0.03, 'SMITHVILLE': 0.005, 'SNYDER': 0.04,
  'SOPER': 0.02, 'SOUTH COFFEYVILLE': 0.02, 'SPARKS': 0.04,
  'SPAVINAW': 0.04, 'SPENCER': 0.05, 'SPERRY': 0.036,
  'SPIRO': 0.03, 'SPORTSMEN ACRES': 0.03, 'SPRINGER': 0.02,
  'STERLING': 0.03, 'STIGLER': 0.035, 'STILLWATER': 0.04,
  'STONEWALL': 0.05, 'STRANG': 0.02, 'STRATFORD': 0.04,
  'STRINGTOWN': 0.03, 'STROUD': 0.04, 'STUART': 0.04,
  'SULPHUR': 0.03, 'SUMMIT': 0.03, 'SWEETWATER': 0.01,
  'TAFT': 0.04, 'TAHLEQUAH': 0.0325, 'TALALA': 0.03,
  'TALIHINA': 0.03, 'TALOGA': 0.03, 'TAMAHA': 0.03,
  'TATUMS': 0.05, 'TECUMSEH': 0.03, 'TEMPLE': 0.03,
  'TERLTON': 0.02, 'TERRAL': 0.03, 'TEXHOMA': 0.03,
  'TEXOLA': 0.01, 'THE VILLAGE': 0.045, 'THOMAS': 0.045,
  'THACKERVILLE': 0.02, 'TIPTON': 0.04, 'TISHOMINGO': 0.03,
  'TONKAWA': 0.045, 'TRIBBEY': 0.02, 'TRYON': 0.04,
  'TULLAHASSEE': 0.04, 'TULSA': 0.0365, 'TUPELO': 0.03,
  'TUSHKA': 0.035, 'TUTTLE': 0.045, 'TYRONE': 0.03,
  'UNION CITY': 0.045, 'VALLIANT': 0.03, 'VALLEY BROOK': 0.03,
  'VELMA': 0.04, 'VERA': 0.02, 'VERDEN': 0.0375,
  'VERDIGRIS': 0.03, 'VERNON': 0.04, 'VIAN': 0.04,
  'VICI': 0.04, 'VINITA': 0.03, 'WAGONER': 0.04,
  'WAINWRIGHT': 0.04, 'WAKITA': 0.04, 'WALTERS': 0.03,
  'WANETTE': 0.035, 'WANN': 0.02, 'WAPANUCKA': 0.015,
  'WARNER': 0.05, 'WARR ACRES': 0.04, 'WASHINGTON': 0.05,
  'WATONGA': 0.06, 'WATTS': 0.04, 'WAUKOMIS': 0.04,
  'WAURIKA': 0.03, 'WAYNE': 0.035, 'WAYNOKA': 0.05,
  'WEATHERFORD': 0.045, 'WEBBERS FALLS': 0.055,
  'WELCH': 0.03, 'WELEETKA': 0.04, 'WELLSTON': 0.04,
  'WESTPORT': 0.025, 'WESTVILLE': 0.0375, 'WETUMKA': 0.05,
  'WEWOKA': 0.0525, 'WHITEFIELD': 0.03, 'WILBURTON': 0.035,
  'WILLOW': 0.02, 'WILSON': 0.04, 'WISTER': 0.03,
  'WOODWARD': 0.04, 'WRIGHT CITY': 0.03, 'WYANDOTTE': 0.03,
  'WYNNEWOOD': 0.045, 'WYNONA': 0.04, 'YALE': 0.04,
  'YEAGER': 0.03, 'YUKON': 0.04
};

// City-to-County mapping (needed to calculate total rate)
// Format: city name (uppercase) -> county name (uppercase)
const CITY_TO_COUNTY = {
  'TONKAWA': 'KAY', 'PONCA CITY': 'KAY', 'BLACKWELL': 'KAY', 'NEWKIRK': 'KAY',
  'KAW CITY': 'KAY', 'BRAMAN': 'KAY', 'NARDIN': 'KAY',
  'CHEROKEE': 'ALFALFA', 'HELENA': 'ALFALFA', 'JET': 'ALFALFA', 'GOLTRY': 'ALFALFA',
  'BURLINGTON': 'ALFALFA', 'BYRON': 'ALFALFA', 'CARMEN': 'ALFALFA', 'ALINE': 'ALFALFA',
  'PERRY': 'NOBLE', 'MORRISON': 'NOBLE', 'BILLINGS': 'NOBLE', 'MARLAND': 'NOBLE',
  'RED ROCK': 'NOBLE',
  'STILLWATER': 'PAYNE', 'PERKINS': 'PAYNE', 'CUSHING': 'PAYNE', 'YALE': 'PAYNE',
  'GLENCOE': 'PAYNE', 'RIPLEY': 'PAYNE',
  'ENID': 'GARFIELD', 'WAUKOMIS': 'GARFIELD', 'COVINGTON': 'GARFIELD',
  'LAHOMA': 'GARFIELD', 'KREMLIN': 'GARFIELD', 'HILLSDALE': 'GARFIELD',
  'DRUMMOND': 'GARFIELD', 'NORTH ENID': 'GARFIELD', 'GARBER': 'GARFIELD',
  'HUNTER': 'GARFIELD', 'CARRIER': 'GARFIELD',
  'MEDFORD': 'GRANT', 'LAMONT': 'GRANT', 'POND CREEK': 'GRANT',
  'DEER CREEK': 'GRANT', 'WAKITA': 'GRANT', 'NASH': 'GRANT', 'RENFROW': 'GRANT',
  'PAWHUSKA': 'OSAGE', 'HOMINY': 'OSAGE', 'FAIRFAX': 'OSAGE', 'BARNSDALL': 'OSAGE',
  'SHIDLER': 'OSAGE', 'BURBANK': 'OSAGE', 'WYNONA': 'OSAGE',
  'AVANT': 'OSAGE', 'PAWNEE': 'PAWNEE', 'CLEVELAND': 'PAWNEE',
  'JENNINGS': 'PAWNEE', 'RALSTON': 'PAWNEE',
  'GUTHRIE': 'LOGAN', 'LANGSTON': 'LOGAN', 'COYLE': 'LOGAN', 'CRESCENT': 'LOGAN',
  'MULHALL': 'LOGAN', 'ORLANDO': 'LOGAN', 'MARSHALL': 'LOGAN',
  'KINGFISHER': 'KINGFISHER', 'HENNESSEY': 'KINGFISHER', 'DOVER': 'KINGFISHER',
  'OKARCHE': 'KINGFISHER', 'LOYAL': 'KINGFISHER', 'CASHION': 'KINGFISHER',
  'CHANDLER': 'LINCOLN', 'STROUD': 'LINCOLN', 'WELLSTON': 'LINCOLN',
  'MEEKER': 'LINCOLN', 'PRAGUE': 'LINCOLN', 'SPARKS': 'LINCOLN',
  'AGRA': 'LINCOLN', 'TRYON': 'LINCOLN', 'CARNEY': 'LINCOLN',
  'OKLAHOMA CITY': 'OKLAHOMA', 'EDMOND': 'OKLAHOMA', 'MIDWEST CITY': 'OKLAHOMA',
  'DEL CITY': 'OKLAHOMA', 'MOORE': 'OKLAHOMA', 'NORMAN': 'CLEVELAND',
  'BETHANY': 'OKLAHOMA', 'THE VILLAGE': 'OKLAHOMA', 'WARR ACRES': 'OKLAHOMA',
  'SPENCER': 'OKLAHOMA', 'NICOMA PARK': 'OKLAHOMA', 'JONES': 'OKLAHOMA',
  'HARRAH': 'OKLAHOMA', 'CHOCTAW': 'OKLAHOMA', 'LUTHER': 'OKLAHOMA',
  'YUKON': 'CANADIAN', 'MUSTANG': 'CANADIAN', 'EL RENO': 'CANADIAN',
  'PIEDMONT': 'CANADIAN', 'UNION CITY': 'CANADIAN', 'CALUMET': 'CANADIAN',
  'TULSA': 'TULSA', 'BROKEN ARROW': 'TULSA', 'BIXBY': 'TULSA',
  'JENKS': 'TULSA', 'OWASSO': 'TULSA', 'SAND SPRINGS': 'TULSA',
  'GLENPOOL': 'TULSA', 'COLLINSVILLE': 'TULSA', 'SKIATOOK': 'OSAGE',
  'SAPULPA': 'CREEK', 'BRISTOW': 'CREEK', 'DRUMRIGHT': 'CREEK',
  'KIEFER': 'CREEK', 'KELLYVILLE': 'CREEK', 'OILTON': 'CREEK',
  'MUSKOGEE': 'MUSKOGEE', 'FORT GIBSON': 'MUSKOGEE', 'HASKELL': 'MUSKOGEE',
  'WAGONER': 'WAGONER', 'COWETA': 'WAGONER',
  'DUNCAN': 'STEPHENS', 'MARLOW': 'STEPHENS', 'COMANCHE': 'STEPHENS',
  'LAWTON': 'COMANCHE', 'CACHE': 'COMANCHE', 'ELGIN': 'COMANCHE',
  'GERONIMO': 'COMANCHE', 'FLETCHER': 'COMANCHE', 'INDIAHOMA': 'COMANCHE',
  'CHICKASHA': 'GRADY', 'MINCO': 'GRADY', 'TUTTLE': 'GRADY',
  'ADA': 'PONTOTOC', 'ROFF': 'PONTOTOC', 'ALLEN': 'PONTOTOC',
  'SHAWNEE': 'POTTAWATOMIE', 'TECUMSEH': 'POTTAWATOMIE',
  'MCLOUD': 'POTTAWATOMIE', 'BETHEL ACRES': 'POTTAWATOMIE',
  'SEMINOLE': 'SEMINOLE', 'WEWOKA': 'SEMINOLE', 'KONAWA': 'SEMINOLE',
  'ARDMORE': 'CARTER', 'DAVIS': 'CARTER', 'LONE GROVE': 'CARTER',
  'DURANT': 'BRYAN', 'CALERA': 'BRYAN', 'CADDO': 'BRYAN',
  'MCALESTER': 'PITTSBURG', 'KREBS': 'PITTSBURG', 'HARTSHORNE': 'PITTSBURG',
  'WOODWARD': 'WOODWARD', 'WEATHERFORD': 'CUSTER', 'CLINTON': 'CUSTER',
  'ALTUS': 'JACKSON', 'HOBART': 'KIOWA', 'WATONGA': 'BLAINE',
  'FAIRVIEW': 'MAJOR', 'ALVA': 'WOODS', 'GUYMON': 'TEXAS',
  'TAHLEQUAH': 'CHEROKEE', 'VINITA': 'CRAIG', 'GROVE': 'DELAWARE',
  'MIAMI': 'OTTAWA', 'JAY': 'DELAWARE', 'PRYOR': 'MAYES',
  'CLAREMORE': 'ROGERS', 'CATOOSA': 'ROGERS', 'SALLISAW': 'SEQUOYAH',
  'POTEAU': 'LEFLORE', 'HEAVENER': 'LEFLORE', 'IDABEL': 'MCCURTAIN',
  'BROKEN BOW': 'MCCURTAIN', 'HUGO': 'CHOCTAW', 'ANTLERS': 'PUSHMATAHA',
  'ATOKA': 'ATOKA', 'COALGATE': 'COAL', 'TISHOMINGO': 'JOHNSTON',
  'MADILL': 'MARSHALL', 'SULPHUR': 'MURRAY', 'PAULS VALLEY': 'GARVIN',
  'LINDSAY': 'GARFIELD', 'PURCELL': 'MCCLAIN', 'BLANCHARD': 'MCCLAIN',
  'GOLDSBY': 'MCCLAIN', 'NEWCASTLE': 'MCCLAIN', 'NOBLE': 'CLEVELAND',
  'LEXINGTON': 'CLEVELAND'
};


// ---------------------------------------------------------------------------------------
// BOUNDARY-BASED JURISDICTION (destination sourcing)
//
// Oklahoma sales tax is owed where the goods are delivered, by actual municipal
// boundary — NOT by the postal city the customer types. A rural address with a
// "Blackwell, OK 74631" mailing address can sit outside Blackwell's city limits and owe
// only state + county. The authoritative test is the US Census geocoder: an
// "Incorporated Places" layer at the point = inside that city's limits (city tax
// applies); absent = unincorporated (state + county only). A CCD ("County Subdivision")
// is a statistical area, never a municipality, and is deliberately ignored here.
//
// DESIGN — nothing in here is ever called from the synchronous pricing path:
//   * resolveTaxJurisdiction() is ASYNC and does the network work (Google Geocoding for
//     address -> point, Census for point -> county/place). It is meant to be awaited in a
//     route handler BEFORE calcPricing, exactly where resolveTaxCity() already awaits a
//     ZIP lookup today.
//   * Its answer is a plain object that is handed to calcPricing()/taxBreakdown() — the
//     pricing functions only do arithmetic on it, so they stay synchronous and cannot
//     block, time out, or fail open.
//   * Every result (including "unincorporated") is cached in memory and in a JSON file,
//     so repeat addresses are free, and peekTaxJurisdiction() reads that cache
//     synchronously for code paths that must never wait.
//   * A hard overall deadline applies; on timeout/any error the resolver returns null and
//     the caller falls back to exactly what it did before (typed/ZIP city).
// Only results that are verified (precise point + Census answer + names in the rate
// tables + not on a city line) are ever returned as jurisdictions.
// ---------------------------------------------------------------------------------------
const _fs = require('fs');
const _path = require('path');

const GEO_TTL_MS = 180 * 24 * 3600 * 1000; // annexations happen; re-verify twice a year
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
const CENSUS_ONELINE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NEAR_BOUNDARY_METERS = 150;       // RANGE_INTERPOLATED cross probes (kept: sampling only ever ADDS points)
const MAX_SAMPLE_SPAN_M = 1000;         // geocoder box wider than this = "somewhere in this area": refuse
const RETRY_MAX_MOVE_M = 100;           // a cleaned-address retry may not land further than this from the original
const CONFIRM_CONFLICT_M = 300;         // Census one-line only counts as a conflict if it points this close to Google's point
const FALLBACK_RING_M = 500;            // Census-only fallback must agree on a ring this wide
const RESOLVER_VERSION = 2;             // bump when the decision rules change; stale UNVERIFIED answers are re-decided

function _cachePath() {
  return process.env.TAX_GEO_CACHE || _path.join(__dirname, '..', 'data', 'tax-geo-cache.json');
}
let _cache = null; // { jur: {key: {at, rv, v}}, geocode: {...}, census: {...}, oneline: {...} }
const _CACHE_KEYS = ['jur', 'geocode', 'census', 'oneline'];
function _loadCache() {
  if (_cache) return _cache;
  _cache = { jur: {}, geocode: {}, census: {}, oneline: {} };
  try {
    const raw = JSON.parse(_fs.readFileSync(_cachePath(), 'utf8'));
    for (const k of _CACHE_KEYS) if (raw && raw[k] && typeof raw[k] === 'object') _cache[k] = raw[k];
  } catch (e) { /* no cache file yet / unreadable: start empty */ }
  return _cache;
}
function _saveCache() {
  try {
    const p = _cachePath();
    const tmp = p + '.' + process.pid + '.tmp';
    _fs.writeFileSync(tmp, JSON.stringify(_cache));
    _fs.renameSync(tmp, p);
  } catch (e) { /* read-only mount (tests) or full disk: in-memory cache still works */ }
}
function _fresh(entry) { return entry && typeof entry.at === 'number' && (Date.now() - entry.at) < GEO_TTL_MS; }
// A cached jurisdiction is usable if it is fresh AND either decided by the current rules or
// VERIFIED (a verified answer from an older rule-set is never silently dropped or changed).
// Stale UNVERIFIED answers are re-decided so the new rules can rescue them.
function _freshJur(entry) {
  return _fresh(entry) && !!entry.v && (entry.rv === RESOLVER_VERSION || entry.v.verified === true);
}

function _normAddr(s) {
  return String(s || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
}
const _r5 = (n) => Math.round(n * 1e5) / 1e5;
function _distM(a, b) {
  return Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180));
}

// "36.5738165, -96.8000899" typed into the address box (map-pin deliveries) is already a point.
function parseLatLng(s) {
  const m = String(s || '').match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (!(lat >= 33 && lat <= 38 && lng >= -104 && lng <= -94)) return null; // Oklahoma's bounding box
  return { lat, lng };
}

function _inputKey(inp) {
  const ll = (Number.isFinite(inp.lat) && Number.isFinite(inp.lng)) ? { lat: inp.lat, lng: inp.lng } : parseLatLng(inp.address);
  if (ll) return 'c:' + _r5(ll.lat) + ',' + _r5(ll.lng);
  const a = _normAddr(inp.address);
  if (!a) return null;
  return 'a:' + a + '|' + _normAddr(inp.city) + '|' + _normAddr(inp.state || 'OK') + '|' + _normAddr(inp.zip);
}
function _query(inp) {
  return [inp.address, inp.city, (inp.state || 'OK'), inp.zip].filter(Boolean).join(', ');
}

async function _getJson(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

// Census: point -> { county, place } for Oklahoma. place === null means NO Incorporated
// Places layer at that point (unincorporated). Throws on transport failure; returns
// { ok:false } if the point is not in Oklahoma / the response has no geographies.
// `save:false` lets a batch of sample points persist the cache once instead of N times.
async function censusLookup(lat, lng, timeoutMs = 3000, save = true) {
  const key = _r5(lat) + ',' + _r5(lng);
  const c = _loadCache();
  if (_fresh(c.census[key])) return c.census[key].v;
  const url = CENSUS_URL + '?x=' + encodeURIComponent(lng) + '&y=' + encodeURIComponent(lat) +
    '&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json';
  let data, lastErr;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    try { data = await _getJson(url, timeoutMs); } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error('census lookup failed');
  const g = data && data.result && data.result.geographies;
  let v;
  const state = g && g['States'] && g['States'][0];
  const county = g && g['Counties'] && g['Counties'][0];
  if (!state || state.NAME !== 'Oklahoma' || !county) {
    v = { ok: false, reason: 'point not resolved to an Oklahoma county' };
  } else {
    const pl = g['Incorporated Places'] && g['Incorporated Places'][0]; // NOT 'County Subdivisions' (CCD)
    // NAME, not BASENAME: Census BASENAME for "Ponca City city" is just "Ponca".
    const placeName = pl ? String(pl.NAME || pl.BASENAME || '').replace(/\s+(city|town|village)$/i, '') : null;
    v = {
      ok: true,
      county: String(county.BASENAME || county.NAME || '').replace(/\s+County$/i, '').toUpperCase(),
      place: placeName ? placeName.toUpperCase().replace(/\s+/g, ' ').trim() : null
    };
  }
  c.census[key] = { at: Date.now(), v };
  if (save) _saveCache();
  return v;
}

// Census ONE-LINE geocoder: free, no key, INDEPENDENT of Google. Address -> point, or no match
// (it matches street addresses only: venue names, bare streets and cities all return 0 matches).
// Throws on transport failure. { ok:true, match:{lat,lng,matched} | null }
async function censusOneLine(q, timeoutMs = 1500) {
  const k = _normAddr(q);
  if (!k) return { ok: true, match: null };
  const c = _loadCache();
  if (_fresh(c.oneline[k])) return c.oneline[k].v;
  const url = CENSUS_ONELINE_URL + '?address=' + encodeURIComponent(q) + '&benchmark=Public_AR_Current&format=json';
  const data = await _getJson(url, timeoutMs);
  const ms = data && data.result && data.result.addressMatches;
  if (!Array.isArray(ms)) throw new Error('census one-line: unexpected response'); // garbage is not "no match"
  const m = ms[0];
  const x = m && m.coordinates && Number(m.coordinates.x), y = m && m.coordinates && Number(m.coordinates.y);
  const v = { ok: true, match: (m && Number.isFinite(x) && Number.isFinite(y)) ? { lat: y, lng: x, matched: String(m.matchedAddress || '') } : null };
  c.oneline[k] = { at: Date.now(), v };
  _saveCache();
  return v;
}

// Google Geocoding: address -> point + how precise it is (+ the extent Google reports for it).
// Throws on transport failure.
async function geocodeAddress(inp, timeoutMs = 3000) {
  const keyEnv = process.env.GOOGLE_MAPS_API_KEY;
  if (!keyEnv) throw new Error('GOOGLE_MAPS_API_KEY not set');
  const k = _inputKey(inp);
  const c = _loadCache();
  const e = k && c.geocode[k];
  // Entries cached before v2 have no viewport/types; they are only reusable where those are unneeded.
  if (_fresh(e) && (e.v.ver === 2 || e.v.ok === false || (e.v.locType === 'ROOFTOP' && !e.v.partial))) return e.v;
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(_query(inp)) +
    '&components=country:US&key=' + encodeURIComponent(keyEnv);
  const data = await _getJson(url, timeoutMs);
  let v;
  if (data.status === 'ZERO_RESULTS') v = { ok: false, reason: 'address not found', ver: 2 };
  else if (data.status !== 'OK') throw new Error('geocode status ' + data.status); // transient/config: not cached
  else {
    const r = data.results[0];
    const st = (r.address_components || []).find((x) => x.types.includes('administrative_area_level_1'));
    const box = (b) => (b && b.northeast && b.southwest) ? { n: b.northeast.lat, e: b.northeast.lng, s: b.southwest.lat, w: b.southwest.lng } : null;
    v = {
      ok: true, ver: 2, lat: r.geometry.location.lat, lng: r.geometry.location.lng,
      locType: r.geometry.location_type, partial: !!r.partial_match,
      state: st ? st.short_name : null, formatted: r.formatted_address,
      types: Array.isArray(r.types) ? r.types : [],
      viewport: box(r.geometry.viewport), bounds: box(r.geometry.bounds)
    };
  }
  if (k) { c.geocode[k] = { at: Date.now(), v }; _saveCache(); }
  return v;
}

// metres -> degree offsets near Oklahoma's latitude
function _probePoints(lat, lng, m) {
  const dLat = m / 111320, dLng = m / (111320 * Math.cos(lat * Math.PI / 180));
  return [[lat + dLat, lng], [lat - dLat, lng], [lat, lng + dLng], [lat, lng - dLng]];
}
function _ringPoints(lat, lng, m) { // 8 points: N,S,E,W + the four diagonals
  const dLat = m / 111320, dLng = m / (111320 * Math.cos(lat * Math.PI / 180)), d = Math.SQRT1_2;
  return [[1, 0], [-1, 0], [0, 1], [0, -1], [d, d], [d, -d], [-d, d], [-d, -d]].map((o) => [lat + o[0] * dLat, lng + o[1] * dLng]);
}

// ---- address hygiene (all PURE) ---------------------------------------------------------------
const STREET_SUFFIX = '(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|cir|circle|pl|place|pkwy|parkway|trl|trail|hwy|highway|cove|loop|ter|terrace|rte|route|pike|path|run|row|xing|crossing)';
// number, optional direction, 1-4 words, then a street-type word ("501 N Public St", "35151 S. 35000 Rd")
const STREET_TOKEN = new RegExp('(?:^|[\\s,;(])(\\d{1,6}\\s+(?:(?:[NSEW]|North|South|East|West)\\.?\\s+)?(?:[A-Za-z0-9\'.-]+\\s+){0,3}?' + STREET_SUFFIX + '\\b\\.?(?:[\\s,].*)?)$', 'i');
// "across from", "near", "behind" ... name a DIFFERENT spot than the street number that follows.
const RELATIONAL = /\b(across|near|nearby|next\s+to|behind|beside|corner|between|opposite|in\s+front|off|by|past|at\s+the|north\s+of|south\s+of|east\s+of|west\s+of)\b/i;

// Strip a leading venue/place phrase in front of the first street-number token:
//   "Tonkawa Elementary School, 501 N Public St, Tonkawa, OK 74653" -> "501 N Public St, Tonkawa, OK 74653"
// Deliberately NOT done: dropping a trailing sub-location ("Ponca Lake Park — Pavilion 7" -> "Ponca
// Lake Park"). The park's centre point sits ~500 m from the Ponca City limit and a pavilion could be
// anywhere in it, so that stays a human question.
// Returns { address, removed, rule } or null when there is nothing safe to strip. It refuses
// relational prefixes ("Across from 200 S 6th St" is NOT 200 S 6th St), so it never turns one
// place into a different one.
function cleanVenueAddress(addr) {
  const s = String(addr || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = STREET_TOKEN.exec(s);
  if (m) {
    const start = m.index + m[0].length - m[1].length;
    const prefix = s.slice(0, start).replace(/[\s,;:(\-–—]+$/, '').trim();
    if (!prefix || prefix.length > 80 || !/[A-Za-z]{3}/.test(prefix)) return null;
    if (RELATIONAL.test(prefix)) return null;
    if (/\b\d{1,6}\s+[A-Za-z]/.test(prefix) && new RegExp('\\b' + STREET_SUFFIX + '\\b', 'i').test(prefix)) return null; // prefix is itself an address
    return { address: s.slice(start).trim(), removed: prefix, rule: 'venue-prefix' };
  }
  return null;
}

// "Blackwell, OK" / "Nardin, OK 74646" / "" + a city: there is nothing to geocode. Returns the
// reason string, or null when the text is something a geocoder can work with.
function addressNeedsHuman(inp) {
  inp = inp || {};
  const raw = _normAddr(inp.address);
  const NOISE = /\b(ok|okla|oklahoma|usa|us|united states)\b/g;
  const rest = raw.replace(NOISE, ' ').replace(/\b\d{5}(?:-\d{4})?\b/g, ' ').replace(/\s+/g, ' ').trim();
  const cityN = _normAddr(inp.city).replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  const known = (n) => n && (n.toUpperCase() in CITY_TO_COUNTY || n.toUpperCase() in CITY_RATES);
  if (!rest) {
    return (inp.address && String(inp.address).trim()) || cityN
      ? 'no street address - only a city/state was given; a human must supply the delivery location'
      : null;
  }
  if (rest === cityN || known(rest)) return 'city only (no street address or venue) - a human must supply the delivery location';
  return null;
}
const _COARSE = ['locality', 'postal_code', 'country', 'administrative_area_level_1', 'administrative_area_level_2',
  'administrative_area_level_3', 'sublocality', 'neighborhood', 'postal_town'];
const _FINE = ['street_address', 'route', 'premise', 'subpremise', 'intersection', 'establishment', 'point_of_interest', 'park'];
function _geocodeIsCoarse(types) {
  return Array.isArray(types) && types.some((t) => _COARSE.includes(t)) && !types.some((t) => _FINE.includes(t));
}

// Pure: turn a Census answer into a jurisdiction, validating names against the rate tables.
function _buildJurisdiction(cen, extra) {
  const base = Object.assign({ source: 'census', verified: false }, extra);
  if (!cen || !cen.ok) return Object.assign(base, { reason: (cen && cen.reason) || base.reason || 'no census answer' });
  if (!(cen.county in COUNTY_RATES)) return Object.assign(base, { reason: 'county "' + cen.county + '" not in rate table' });
  if (cen.place && !(cen.place in CITY_RATES) && !(cen.place in CITY_TO_COUNTY)) {
    return Object.assign(base, { reason: 'incorporated place "' + cen.place + '" not in rate table', countyName: cen.county, placeKey: cen.place });
  }
  return Object.assign(base, { verified: true, countyName: cen.county, placeKey: cen.place || null });
}
const _sameJur = (a, b) => !!a && !!b && a.ok && b.ok && a.county === b.county && a.place === b.place;

// Points to test for an imprecise geocode: the centre, the four corners of Google's viewport
// (and of its `bounds`, when it gives one), and - for interpolated points - the 150 m cross.
// Returns { points, spanM } (deduped to 5 decimals; the centre is always first).
function _samplePoints(g) {
  const pts = [{ lat: g.lat, lng: g.lng, tag: 'centre' }];
  let n = -90, s = 90, e = -180, w = 180;
  const take = (b, tag) => {
    if (!b) return;
    n = Math.max(n, b.n); s = Math.min(s, b.s); e = Math.max(e, b.e); w = Math.min(w, b.w);
    pts.push({ lat: b.n, lng: b.e, tag: tag + '-NE' }, { lat: b.n, lng: b.w, tag: tag + '-NW' },
      { lat: b.s, lng: b.e, tag: tag + '-SE' }, { lat: b.s, lng: b.w, tag: tag + '-SW' });
  };
  take(g.viewport, 'viewport'); take(g.bounds, 'bounds');
  if (g.locType === 'RANGE_INTERPOLATED') {
    for (const p of _probePoints(g.lat, g.lng, NEAR_BOUNDARY_METERS)) pts.push({ lat: p[0], lng: p[1], tag: 'probe' });
  }
  const seen = new Set(), out = [];
  for (const p of pts) { const k = _r5(p.lat) + ',' + _r5(p.lng); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  const spanM = (n > s) ? _distM({ lat: n, lng: e }, { lat: s, lng: w }) : 0;
  return { points: out, spanM };
}

// Census-check every point in parallel and resolve at the FIRST disagreement with the centre
// (the remaining lookups keep running and warm the cache). Resolves
//   { agree:true, samples }                      all points answered and all agree
//   { agree:false, samples, why }                some point differs / is not in Oklahoma
// and REJECTS if no point disagreed but one could not be looked up (a transport failure is
// not evidence; the caller must not cache it as an answer).
function _sampleAll(points, centreCen, timeoutMs) {
  return new Promise((resolve, reject) => {
    const samples = [];
    let pending = points.length, done = false, failure = null;
    const finish = (val) => {
      if (done) return; done = true;
      _saveCache();
      resolve(val);
    };
    for (const p of points) {
      censusLookup(p.lat, p.lng, timeoutMs, false).then((cen) => {
        if (done) return;
        samples.push({ lat: _r5(p.lat), lng: _r5(p.lng), tag: p.tag, county: cen.ok ? cen.county : null, place: cen.ok ? cen.place : null });
        if (!_sameJur(centreCen, cen)) {
          return finish({ agree: false, samples, why: p.tag + ' point is in ' + (cen.ok ? (cen.place ? cen.place + ' city' : 'unincorporated ' + cen.county + ' County') : 'a different/unknown area') });
        }
        if (--pending === 0) { if (failure) { done = true; reject(failure); } else finish({ agree: true, samples }); }
      }, (err) => {
        if (done) return;
        failure = failure || err;
        if (--pending === 0) { done = true; reject(failure); }
      });
    }
  });
}

// Census one-line quietly drops words it cannot parse ("11455 South Main" matched "11455 MAIN ST",
// 2.5 km from where Google put it; "Across from 200 S 6th St" matched 200 S 6th St). When it is the
// ONLY source, the street it matched must carry every word the customer typed (directions
// normalised, street-type words ignored) and the same ZIP, or it is not trusted.
const _DIR = { north: 'n', south: 's', east: 'e', west: 'w' };
const _SFX = new Set('st street ave avenue rd road dr drive ln lane blvd boulevard way ct court cir circle pl place pkwy parkway trl trail hwy highway'.split(' '));
function _streetToks(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((t) => _DIR[t] || t);
}
function _matchedConsistent(inp, matched) {
  const first = String(inp.address || '').split(',')[0];
  const want = _streetToks(first).filter((t) => !_SFX.has(t));
  const have = new Set(_streetToks(String(matched || '').split(',')[0]));
  if (!want.length || !want.every((t) => have.has(t))) return false;
  const mz = String(matched || '').match(/\b(\d{5})\b\s*$/), iz = String(inp.zip || '').match(/^\d{5}/);
  return !(mz && iz && mz[1] !== iz[0]);
}

// Independent second opinion from the Census one-line geocoder. NEVER rescues anything: it
// can only confirm, stay silent, or (when it points within CONFIRM_CONFLICT_M of Google's own
// point yet lands in a different jurisdiction) raise a conflict. Its interpolated points
// can be hundreds of metres to kilometres off on rural roads - 775 N Public St is 629 m
// from Google's ROOFTOP point and across the city line - so a far-away disagreement is
// recorded as inconclusive, not as a veto.
// Started EARLY (alongside the Google call) so the confirmer adds no serial latency; never rejects.
function _startConfirm(query, timeoutMs) {
  return (async () => {
    try {
      const one = await censusOneLine(query, Math.min(1500, timeoutMs));
      if (!one.match) return { status: 'nomatch' };
      return { match: one.match, c2: await censusLookup(one.match.lat, one.match.lng, timeoutMs) };
    } catch (e) { return { status: 'unavailable' }; }
  })();
}
function _judgeConfirm(raw, pt, cen) {
  if (!raw || !raw.match) return { status: (raw && raw.status) || 'unavailable' };
  const d = Math.round(_distM(pt, raw.match));
  if (!raw.c2.ok) return { status: 'inconclusive', distanceM: d };
  if (_sameJur(cen, raw.c2)) return { status: 'confirmed', distanceM: d };
  return { status: d <= CONFIRM_CONFLICT_M ? 'conflict' : 'inconclusive', distanceM: d, census: { county: raw.c2.county, place: raw.c2.place } };
}

const _unv = (reason, extra) => _buildJurisdiction(null, Object.assign({ reason }, extra));

// Async resolver. Returns a jurisdiction object
//   { verified, countyName, placeKey|null, source, precision, lat, lng, nearBoundary, reason,
//     needsHuman?, sampled?, samples?, retry?, confirm? }
// or null on deadline / transport failure / insufficient input. NEVER throws.
// verified === false carries a `reason` (e.g. imprecise geocode, near a city line); callers
// must treat that exactly like "no better signal" and keep their existing behaviour.
// needsHuman === true means there was nothing to geocode (city only): do not infer a rate.
async function resolveTaxJurisdiction(inp, opts) {
  inp = inp || {};
  const deadlineMs = (opts && opts.deadlineMs) || 4000;
  const t0 = Date.now();
  const left = () => Math.max(400, Math.min(3000, deadlineMs - (Date.now() - t0) - 150)); // per-call timeout inside the overall budget
  const key = _inputKey(inp);
  if (!key) return null;
  const c = _loadCache();
  if (_freshJur(c.jur[key])) return c.jur[key].v;

  const work = (async () => {
    let pt = (Number.isFinite(inp.lat) && Number.isFinite(inp.lng)) ? { lat: inp.lat, lng: inp.lng } : parseLatLng(inp.address);
    let precision, via, g = null, retry = null, query = _query(inp), fallback = false, confP = null;
    if (pt) { precision = 'coordinates'; via = 'coordinates'; }
    else {
      const nh = addressNeedsHuman(inp);
      if (nh) return _unv(nh, { via: 'input', needsHuman: true });
      confP = _startConfirm(query, left()); // runs concurrently with the Google call
      try {
        g = await geocodeAddress(inp, left());
        via = 'google-geocode';
      } catch (gerr) {
        // Google unavailable (no key / quota / outage / garbage). The Census one-line geocoder is an
        // independent source: use it, but only under a much stricter test (see below). If it has no
        // match either, surface the ORIGINAL failure so nothing is cached and the caller falls back.
        // (confP has been in flight since before the Google call, so this adds no waiting.)
        const raw = confP ? await confP : null;
        const one = raw && raw.match ? raw : null;
        if (!one) throw gerr;
        if (!_matchedConsistent(inp, one.match.matched)) {
          return _unv('Google unavailable; the Census one-line match "' + one.match.matched + '" does not carry the street as typed - not trusted on its own', { via: 'census-oneline', fallback: 'google-unavailable' });
        }
        fallback = true; via = 'census-oneline';
        g = { ok: true, lat: one.match.lat, lng: one.match.lng, locType: 'CENSUS_INTERPOLATED', partial: false, state: 'OK', types: ['street_address'] };
      }
      if (!g.ok) return _unv(g.reason, { via });
      if (g.state !== 'OK') return _unv('geocoded outside Oklahoma', { via });
      if (_geocodeIsCoarse(g.types)) return _unv('geocoded only to a city/area (' + g.types.slice(0, 2).join('/') + ') - no street or venue to test; a human must supply the delivery location', { via, needsHuman: true, precision: g.locType });

      // FIX B: a PARTIAL match is discarded - unless the same address minus a leading venue name
      // (or a trailing "- Pavilion 7") geocodes cleanly AND lands where the original did.
      if (g.partial) {
        const cl = cleanVenueAddress(inp.address);
        const why0 = (r) => _unv(r, { via, precision: g.locType, lat: g.lat, lng: g.lng });
        if (!cl) return why0('partial address match');
        // (a transport failure here throws on purpose: a "partial" verdict must not be cached from it)
        const g2 = await geocodeAddress(Object.assign({}, inp, { address: cl.address }), left());
        if (!g2.ok || g2.partial || g2.state !== 'OK') return why0('partial address match; cleaned retry (' + cl.rule + ') was ' + (!g2.ok ? 'not found' : g2.partial ? 'also partial' : 'outside Oklahoma'));
        if (_geocodeIsCoarse(g2.types)) return why0('partial address match; cleaned retry only resolved to a city/area');
        // "Materially different": the retry may not have MOVED the point (> RETRY_MAX_MOVE_M) and the
        // two points must sit in the same county/city per the Census layer.
        const moved = Math.round(_distM(g, g2));
        const [cA, cB] = await Promise.all([censusLookup(g.lat, g.lng, left()), censusLookup(g2.lat, g2.lng, left())]);
        retry = { rule: cl.rule, removed: cl.removed, cleaned: cl.address, movedM: moved, formatted: g2.formatted };
        if (moved > RETRY_MAX_MOVE_M) return why0('cleaned retry moved the point ' + moved + ' m (> ' + RETRY_MAX_MOVE_M + ' m) - not the same place; refusing to guess');
        if (!_sameJur(cA, cB)) return why0('cleaned retry lands in a different jurisdiction than the original match; refusing to guess');
        g = g2; query = _query(Object.assign({}, inp, { address: cl.address }));
        confP = _startConfirm(query, left()); // confirm the CLEANED address, not the venue text
      }
      pt = { lat: g.lat, lng: g.lng };
      precision = g.locType;
      if (g.locType !== 'ROOFTOP' && g.locType !== 'RANGE_INTERPOLATED' && g.locType !== 'GEOMETRIC_CENTER' && !fallback) {
        return _unv('geocode too imprecise (' + g.locType + ')', { via, precision, lat: pt.lat, lng: pt.lng });
      }
    }

    const cen = await censusLookup(pt.lat, pt.lng, left());
    const extra = { via, precision, lat: pt.lat, lng: pt.lng, nearBoundary: false };
    if (retry) extra.retry = retry;
    let j = _buildJurisdiction(cen, extra);
    if (!j.verified) return j;

    // MULTI-POINT SAMPLING. Imprecision only matters if it crosses a boundary, so every point the
    // geocoder could plausibly mean must give the same county + city. A ROOFTOP point is exact and
    // is NOT sampled (Google's ROOFTOP viewport is still ~385 m across - it is a display frame,
    // not an error bar - so sampling it would only refuse good answers).
    // A Census-only fallback point is interpolated along a street and can be hundreds of metres
    // off, so it must agree on a wide ring.
    if (precision === 'RANGE_INTERPOLATED' || precision === 'GEOMETRIC_CENTER' || fallback) {
      let points, spanM = 0;
      if (fallback) { points = [{ lat: pt.lat, lng: pt.lng, tag: 'centre' }].concat(_ringPoints(pt.lat, pt.lng, FALLBACK_RING_M).map((p) => ({ lat: p[0], lng: p[1], tag: 'ring' }))); }
      else { const sp = _samplePoints(g); points = sp.points; spanM = sp.spanM; }
      if (spanM > MAX_SAMPLE_SPAN_M) {
        return Object.assign(j, { verified: false, reason: 'geocoder area too large to sample safely (' + Math.round(spanM) + ' m across, ' + precision + ')' });
      }
      const sm = await _sampleAll(points, cen, left());
      j.sampled = true; j.sampleCount = points.length; j.samples = sm.samples;
      if (!sm.agree) {
        j = Object.assign(j, { verified: false, nearBoundary: true, reason: 'sample points disagree (' + sm.why + ') - on or near a city/county line' });
        return j;
      }
    }

    // Independent Census one-line second opinion (never a rescue, only confirm / conflict).
    if (!fallback && via === 'google-geocode' && confP) {
      const cf = _judgeConfirm(await confP, pt, cen);
      j.confirm = cf;
      if (cf.status === 'conflict') {
        j = Object.assign(j, { verified: false, reason: 'Google and the Census one-line geocoder disagree ' + cf.distanceM + ' m from the same spot (' + (cf.census.place ? cf.census.place + ' city' : 'unincorporated ' + cf.census.county) + ')' });
      }
    }
    if (fallback) j.fallback = 'google-unavailable';
    return j;
  })();

  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); });
  // A Census-only answer that is NOT verified must not be remembered for 180 days: Google may be back tomorrow.
  const remember = (j) => { if (j && !(j.fallback && !j.verified)) { c.jur[key] = { at: Date.now(), rv: RESOLVER_VERSION, v: j }; _saveCache(); } };
  try {
    // `work` keeps running after the deadline and still fills the cache for the next call.
    const j = await Promise.race([work.catch(() => null), deadline]);
    if (j) remember(j);
    else work.then((late) => remember(late)).catch(() => {});
    return j || null;
  } finally { clearTimeout(timer); }
}

// SYNC, cache-only. For code that must never wait. Returns a jurisdiction or null.
function peekTaxJurisdiction(inp) {
  try {
    const key = _inputKey(inp || {});
    if (!key) return null;
    const e = _loadCache().jur[key];
    return _freshJur(e) ? e.v : null;
  } catch (e) { return null; }
}

// Rate arithmetic for a jurisdiction object. Returns null unless it is verified.
function jurisdictionBreakdown(j) {
  if (!j || typeof j !== 'object' || j.verified !== true) return null;
  const countyName = String(j.countyName || '').toUpperCase();
  if (!(countyName in COUNTY_RATES)) return null;
  const key = j.placeKey ? String(j.placeKey).toUpperCase() : null;
  if (key && !(key in CITY_RATES) && !(key in CITY_TO_COUNTY)) return null;
  const countyRate = COUNTY_RATES[countyName] || 0;
  const cityRate = key ? (CITY_RATES[key] || 0) : 0; // unincorporated => no city tax
  return {
    key: key || ('UNINCORPORATED ' + countyName), countyName, countyRate, cityRate,
    stateRate: STATE_RATE, total: STATE_RATE + countyRate + cityRate,
    unincorporated: !key, basis: j.source || 'census'
  };
}

module.exports = {
  STATE_RATE, COUNTY_RATES, CITY_RATES, CITY_TO_COUNTY,
  resolveTaxJurisdiction, peekTaxJurisdiction, jurisdictionBreakdown, censusLookup, censusOneLine, geocodeAddress, parseLatLng,
  cleanVenueAddress, addressNeedsHuman
};

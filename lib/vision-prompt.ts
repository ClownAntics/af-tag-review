/**
 * Default Claude-vision prompt, shared by server and client.
 * Split out of lib/vision.ts so it stays importable in client components
 * without pulling in the Anthropic SDK.
 */
export const DEFAULT_PROMPT = `You classify decorative garden/house flag designs against the FL Themes taxonomy.

TASK
Given an image, emit one JSON object with exactly these keys:
  "primary"    — the single Search Term that best captures this flag's purpose
                 (pick whichever taxonomy level fits cleanly)
  "decoration" — array of Search Terms for every distinct visible element that
                 has a taxonomy match: flowers, birds, objects, symbols,
                 patterns, text sentiment
  "reasoning"  — one sentence explaining the primary pick

HOW TO PICK "primary" — first match wins, top to bottom:
  1. A specific holiday, occasion, or theme the flag depicts
     (e.g. Christmas, Valentines-Day, Memorial, Welcome, Patriotic, Monogrammed)
  2. A season if no specific holiday/theme fits
     (e.g. Fall, Summer)
  3. The core visible subject if nothing above fits
     (e.g. Birds, Flowers)

RULES
1. Every term must be a Search Term that appears verbatim in the taxonomy below.
2. Match meaning, not text. A memorial flag with "Forever Loved" text is NOT
   about Anniversary; match on the flag's actual purpose, not lexical matches.
3. Pick the MOST SPECIFIC level you can confidently identify. If you see roses,
   pick "Roses" (Level 3). Go up only when you genuinely can't tell.
4. If two sibling sub-themes both seem to fit, you're hedging — pick the one
   you're more confident in, or pick neither and use the parent instead.
5. Skip monogram letters (A/B/C…). For monogram flags, primary is "Monogrammed".
6. Don't tag iconographic elements of a SYMBOL as decoration. On an American
   flag, stars and stripes ARE the flag — don't add "Stars" or "Stripes"
   (those are under Patterns, for actual pattern designs). Likewise on a
   religious cross, "Cross" is the subject, not a decoration.
7. Only apply holiday/seasonal tags when there is EXPLICIT holiday context in
   the image — date text, fireworks, jack-o-lanterns, party imagery, etc. A
   plain American flag is NOT a 4th of July design unless 4th-of-July imagery
   is actually present. A Halloween scene is NOT a Fall design — once a
   specific holiday applies, the season is redundant and conflicts.

PROCESS
First identify the primary using the ordered list above. Then inventory
everything else visible that has a taxonomy entry. Server-side code fills in
parent chains; you don't need to include them.

EXAMPLES

Image: blue butterflies, pink hydrangeas, text "Forever Loved"
{"primary":"Memorial","decoration":["Butterflies","Hydrangeas","Lilacs"],"reasoning":"Mourning/remembrance design; 'Forever Loved' is a eulogy, not an anniversary."}

Image: Isaiah 40:8 scripture with roses and hummingbird
{"primary":"Bible-Scriptures","decoration":["Roses","Hummingbirds"],"reasoning":"Scripture verse is the subject; roses and hummingbird are decorative frame."}

Image: Christmas tree with cardinals in snow
{"primary":"Christmas","decoration":["Christmas-Trees","Cardinals"],"reasoning":"Winter holiday scene with decorated tree; cardinals are decorative."}

Image: American flag with sunflowers, text "Land of the Free"
{"primary":"Patriotic","decoration":["American-Flags","Sunflowers"],"reasoning":"Patriotic theme is dominant; sunflowers decorate."}

Image: calligraphy "Welcome" on plain background
{"primary":"Welcome","decoration":[],"reasoning":"Pure greeting, no identifiable decorative subjects."}

Image: monogrammed "M" with scattered flowers
{"primary":"Monogrammed","decoration":["Flowers"],"reasoning":"Monogram is the subject; letter-specific tags are intentionally skipped."}

Image: fall leaves and pumpkins with no holiday text
{"primary":"Fall","decoration":["Fall-Leaves","Pumpkins"],"reasoning":"No specific holiday shown; season is the best primary."}

Image: unidentifiable mixed bouquet
{"primary":"Flowers","decoration":[],"reasoning":"Cannot identify specific species; core subject is generic flowers."}

TAXONOMY (SearchTerm — display label)
{{taxonomy}}`;

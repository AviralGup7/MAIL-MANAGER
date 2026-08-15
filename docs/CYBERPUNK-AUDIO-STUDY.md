# Cyberpunk Audio Study — Synthesizer Translation

This document records what the project learned from publicly described Cyberpunk 2077 sound design and public UI event catalogs. It does **not** contain, link to, extract, transcribe, or redistribute game audio.

## Sources studied

- CD PROJEKT RED sound-team interview, “Cyberpunk 2077: Inventing the Sound of the Future”:
  `https://www.asoundeffect.com/cyberpunk-2077-sound/`
- CDPR audio discussion emphasizing subtle environmental reactions and strong alerts only when consequential:
  `https://www.fandom.com/articles/cyberpunk-2077-audio`
- Publicly visible UI event names showing the functional taxonomy used by the game: hover, on-press, open, close, enter, exit, done, fail, value-up/down, loading start/complete, equip/unequip, map-pin and tutorial events. No files were downloaded.
- General UI sound-design principles from Ross Tregenza’s UI sound design discussion:
  `https://www.asoundeffect.com/game-ui-sound-design/`

## Design conclusions

1. **Believable before futuristic.** CDPR’s team describes an organic, physical, sometimes dirty/raw foundation with standout futuristic layers on top. Pure clean beeps are insufficient.
2. **Layer materials.** A short tonal oscillator provides readable state; a quieter generated electrical-noise transient provides tactility.
3. **Use a functional taxonomy.** Navigation, activation, open, close, value change, data flow, success, warning and failure deserve distinct motifs.
4. **Strong markers are scarce.** Errors and dangerous actions may be prominent; navigation must remain subtle.
5. **Avoid permanent menu ambience.** Repetitive static/whistle ambience is commonly reported as fatiguing. This extension therefore has no idle audio loop.
6. **Adapt in real time.** Visual intensity, audio detail and the global sound preference affect the very next event.
7. **Keep the language coherent.** A compact synthesized palette is better than a mosaic of unrelated downloaded sounds.
8. **Never make sound authoritative.** Visible and announced state remains complete without audio.

## Original synthesis translation

- `navigate`: high, short sine fall plus a tiny electrical transient.
- `activate`: rising square tone plus filtered transient.
- `open`: rising triangle with a mid-band electrical layer.
- `close`: descending triangle with a darker transient.
- `valueUp` / `valueDown`: paired directional square gestures.
- `data`: bright sweep for a committed value/data operation.
- `success`: two-step rising sine acknowledgement.
- `warning`: descending triangle with restrained urgency.
- `error`: low saw/square pair with dirty low-band transient.
- `arrival`: original three-stage rising saw sequence.

Every layer is generated at runtime using Web Audio oscillators, generated noise buffers, filters and gain envelopes. No sampled game material ships.

## Safety limits

- Lazy creation inside a trusted gesture.
- Feedback outside a gesture may reuse but never create a context.
- Maximum 12 simultaneous voices.
- Ended nodes disconnect and leave the voice registry.
- `pagehide` closes the context.
- Minimal, Semantic and Full profiles.
- Global sound-off always wins.
- Calm visual mode removes navigation audio.
- No intervals or idle loops.

# Classifier correction and retractions

This document is the stable home for four classifier claims that were once
reported as defects and later disproved by the recovered rule order and pipeline
contract. They remain recorded so the same plausible-looking changes are not
reintroduced.

| Retracted claim | Verified behavior |
|---|---|
| `placement unit` appearing in both clubs and internship misfiles placement mail | Internship is evaluated before clubs and already wins. The later entry is redundant, not behavior-changing. |
| `external-promotions` sees `unsubscribe` first and steals GitHub notifications | The first sender stage reads the From header, not message body/list-unsubscribe content. GitHub reaches external services. |
| `tedxPilani` is dead because the corpus is lowercased | Both matcher input and rule are normalized; the mixed-case source spelling is reachable. |
| AUGSD matching requires an `@bits-pilani` address | The ordered sender list already includes a bare AUGSD display-name signal. |

## Binding rule

Generated classifier data must be changed through
`docs/CLASSIFICATION_DATA_PACK.md` and the generators. Do not hand-edit
`src/classify/pattern-rules.js` or `src/classify/address-map.js`.

## Confirmed defects that were separate

Two actual port defects were verified and remain regression-tested:

1. `senderExact` is an inclusion test over the normalized From header, not
   equality against the entire header.
2. Internal BITS rules require a verified BITS domain/subdomain; lookalike
   suffixes such as `bits-pilani.ac.in.evil.example` are external.

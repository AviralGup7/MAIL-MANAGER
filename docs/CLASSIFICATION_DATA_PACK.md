# BITS Mail Manager — Full Classification Data Pack

> Single source of truth for the new extension.  
> Source: old repo `Bits Mail Manager/lib/sender-rules.js`, `lib/pattern-classifier/rules/*.js`, `lib/pattern-classifier/rules/index.js`, and `email-mappings/*.json`.

---

## 1. Categories (exact internal names)

```
admin
administration
augsd
academics
ps
competitions
clubs
events
internship
library
technology
external-promotions
external-services
spam
other
```

## 2. Display Labels

```
admin               → Admin
administration      → Administration
augsd               → AUGSD
academics           → Academics
ps                  → Practice School
competitions        → Competitions
clubs               → Clubs
events              → Events
internship          → Internship
library             → Library
technology          → Technology
external-promotions → Ext Promotions
external-services   → Ext Services
spam                → Spam
other               → Other
```

---

## 3. BITS Domains

```text
pilani.bits-pilani.ac.in
goa.bits-pilani.ac.in
hyderabad.bits-pilani.ac.in
dubai.bits-pilani.ac.in
bits-pilani.ac.in
```

---

## 4. Sender Rules (verbatim)

> Source: `lib/sender-rules.js`  
> Priority: top-to-bottom. First match wins.  
> Patterns use case-insensitive substring matching against the full "From" header value.

```js
export const SENDER_RULES = [
  {
    category: 'admin',
    patterns: [
      'registrar@bits-pilani',
      'admin@bits-pilani',
      'controller@bits-pilani',
      'office of the registrar',
      'office of the controller',
      'bits admin',
      'registrar@pilani.bits',
      'mailadmin@bits-pilani',
      'it.admin@bits-pilani',
      'itsupport@bits-pilani',
      'mailadmin',
      'it.admin',
      'itsupport',
    ],
  },
  {
    category: 'library',
    patterns: [
      'library@bits-pilani',
      'library.bits-pilani',
      'librarian@bits-pilani',
      'circulation@bits-pilani',
      'overdue@bits-pilani',
      'book.issue@bits-pilani',
      'book.return@bits-pilani',
      'lending@bits-pilani',
    ],
  },
  {
    category: 'ps',
    patterns: [
      'psd@bits-pilani',
      'ps-cell@bits-pilani',
      'practice.school@bits-pilani',
      'psdivision@bits-pilani',
      'ps cell',
      'practice school',
      'psd',
      'ps division',
    ],
  },
  {
    category: 'augsd',
    patterns: [
      'augsd@bits-pilani',
      'augsd.bits-pilani',
      'academic.section@bits-pilani',
      'augSD',
      'Academic Section',
    ],
  },
  {
    category: 'academics',
    patterns: [
      'professor@bits-pilani',
      'faculty@bits-pilani',
      'hod@bits-pilani',
      'department@bits-pilani',
      'teaching.assistant@bits-pilani',
    ],
  },
  {
    category: 'administration',
    patterns: [
      'director@bits-pilani',
      'dean@bits-pilani',
      'chief warden@bits-pilani',
      'associate.dean@bits-pilani',
      'office of the dean',
      'office of the director',
      'dean.academics@',
      'dean.student@',
      'chief warden',
      'associate dean',
      'director@pilani.bits',
      'dean@pilani.bits',
      'campus bench',
      'infrastructure',
      'campus services',
      'hostel@bits-pilani',
      'warden@bits-pilani',
      'hostel.admin@bits-pilani',
      'mess@bits-pilani',
      'mess services',
      'election commission',
    ],
  },
  {
    category: 'internship',
    patterns: [
      'placement@bits-pilani',
      'training-and-placement@bits-pilani',
      'tpo@bits-pilani',
      'placement.unit@bits-pilani',
      'placement office',
      'training and placement',
      'placement unit',
    ],
  },
  {
    category: 'external-promotions',
    patterns: [
      'newsletter@',
      'marketing@',
      'promo@',
      'unsubscribe',
      'noreply@spam',
      'lottery',
      'prize winner',
      'congratulations you won',
    ],
  },
  {
    category: 'external-services',
    patterns: [
      'github.com',
      'openai.com',
      'anthropic.com',
      'kaggle.com',
      'medium.com',
      'substack.com',
      'nvidia.com',
      'huggingface.co',
      'dev.to',
      'stackoverflow.com',
      'arxiv.org',
    ],
  },
  {
    category: 'competitions',
    patterns: [
      'hackathon',
      'hackfest',
      'hackweek',
      'hackerrank',
      'codechef',
      'codeforces',
      'flipkart grid',
      'smartprix',
      'zerodha',
      'rubix',
      'aerotrix',
      'enumerate',
      'byteverse',
    ],
  },
  {
    category: 'clubs',
    patterns: [
      'bitsaa.org',
      'bits-pilani.ac.in/clubs',
      'bits pilani club',
      'arbits',
      'astro club',
      'bitsmun',
      'coding club',
      'comedy hub',
      'comhub',
      'communo',
      'consulting club',
      'bpcc',
      'crac',
      'creative activities club',
      'cubing club',
      'dance club',
      'debating society',
      'embryo',
      'elas',
      'english language activities',
      'english press club',
      'fmac',
      'fashion club',
      'fitbits',
      'gaming club',
      'gdsc',
      'google developer student',
      'gurukul',
      'hindi activities society',
      'has.pilani',
      'hindi drama club',
      'hdc.pilani',
      'hindi press club',
      'hpc.pilani',
      'kalamvansh',
      'karaoke club',
      'kc.pilani',
      'mac.pilani',
      'matrix.pilani',
      'media relations club',
      'mrc.pilani',
      'mime club',
      'music club',
      'nss.pilani',
      'national service scheme',
      'nirmaan',
      'operations and strategies club',
      'parc.pilani',
      'atamnirbhar',
      'photography club',
      'photog',
      'poetry club',
      'postman lab',
      'product management club',
      'pm.pilani',
      'public policy club',
      'ppc.pilani',
      'quant club',
      'radioaktiv',
      'renewable energy club',
      'sac.pilani',
      'students academic cell',
      'sovesa',
      'spic macay',
      'sarc.pilani',
      'students alumni relations',
      'tedx',
      'tedxPilani',
      'the eastern outlook',
      'toastmasters',
      'biological association',
      'chemical engineering association',
      'chemistry association',
      'civil engineering association',
      'computer science association',
      'eee association',
      'economics and finance association',
      'humanities association',
      'humanities and social sciences',
      'instrumentation forum',
      'manufacturing engineering',
      'mathematics association',
      'mechanical engineering association',
      'pharmacy association',
      'physics association',
      'bits pilani association',
      'andhra samiti',
      'capitol',
      'gurjari',
      'haryana cultural',
      'kairali',
      'udgam',
      'kannada vedike',
      'madhyansh',
      'maharashtra mandal',
      'maurya vihar',
      'moruchhaya',
      'punjab cultural',
      'sangam',
      'tamil mandram',
      'utkal samaj',
      'share.pilani',
      'ifsa.pilani',
      'acm.pilani',
      'ieee.pilani',
      'asme.pilani',
      'ai-che',
      'ii-che',
      'acm-w',
      'anant',
      'ikr.pilani',
      'gravity.pilani',
      'electric.pilani',
      'radio control',
      'robocon',
      'team bits',
      'sally robotics',
      'criss.pilani',
      'kxr lab',
      'sutt.pilani',
      'cel.pilani',
      'entrepreneurship and leadership',
      'pilani innovation',
      'ieds',
      '180dc',
      'wall street club',
      'sports financial committee',
      'corroboration and review',
      'placement unit',
      'advisory and monitoring',
      'students union',
    ],
  },
  {
    category: 'events',
    patterns: [
      'oasis.bits-pilani',
      'apogee.bits-pilani',
      'oasis@bits-pilani',
      'apogee@bits-pilani',
    ],
  },
  {
    category: 'spam',
    patterns: [
      'spam',
      'phishing',
      'malware',
    ],
  },
];
```

---

## 5. Pattern Rules

> Source: `lib/pattern-classifier/rules/*.js`  
> These are used only when sender rules do not match.

### 5a. Scoring Constants

```js
FIELD_WEIGHTS = { sender: 1.5, subject: 1.2, snippet: 1.0 }
SENDER_EXACT_BONUS = 80
SENDER_CONTAINS_BONUS = 55
SENDER_PENALTY = 30
DIMINISHING_RETURNS_FACTOR = 0.6
CONFLICT_OVERLAP_RATIO = 0.9
```

### 5b. Confidence Calibration

```
rawScore 0     → confidence 0.30
rawScore 1-4   → confidence 0.30 + (score/5)*0.1  (linear ramp)
rawScore 5     → confidence 0.40
rawScore 25    → confidence 0.55
rawScore 45    → confidence 0.70
rawScore 65    → confidence 0.82
rawScore 90    → confidence 0.90
rawScore 120   → confidence 0.95
rawScore 150+  → confidence 0.98
```

### 5c. Precedence Rules

1. Sender classification runs first. If it matches, pattern classification is skipped.
2. Within sender rules: **first match wins** (array top-to-bottom order).
3. Within pattern rules: **highest score wins**.
4. Tie-breaking: if top two scores are within 10% (`CONFLICT_OVERLAP_RATIO = 0.9`), prefer the one with a sender match (`hasSenderMatch`).
5. Custom rules (from user settings) are merged after built-in rules, so a higher-scoring custom rule can override a built-in rule.
6. No multi-label: one category per email.

---

## 6. Pattern Rule Definitions

### 6a. admin

```js
export default {
  category: 'admin',
  senderExact: [
    'registrar',
    'dean',
    'director',
    'principal',
    'controller of examination',
    'office of the registrar',
    'office of the dean',
    'bits admin',
    'mail admin',
    'mail administrator',
    'chief warden',
    'associate dean',
  ],
  senderContains: [
    'registrar@',
    'dean@',
    'director@',
    'admin@bits-pilani',
    'mailadmin@',
    'mail-admin@',
    'chief warden@',
    'associate.dean@',
  ],
  subjectWeights: {
    circular: 70,
    'official notice': 75,
    notification: 50,
    policy: 55,
    ordinance: 60,
    regulation: 50,
    holiday: 50,
    'institute holiday': 65,
    'institute closure': 65,
    'holiday list': 60,
    'important notice': 55,
    mandatory: 45,
    convocation: 60,
    'fee deadline': 55,
    'fee payment': 55,
    'tuition fee': 55,
    'anti-ragging': 60,
    disciplinary: 55,
  },
  snippetWeights: {
    circular: 35,
    notice: 20,
    mandatory: 25,
    holiday: 25,
    policy: 25,
  },
};
```

### 6b. administration

```js
export default {
  category: 'administration',
  senderContains: [
    'infrastructure',
    'installation',
    'hostel',
    'warden',
    'mess',
  ],
  subjectWeights: {
    campus: 50,
    bench: 40,
    installation: 55,
    infrastructure: 60,
    maintenance: 50,
    facility: 50,
    'office order': 65,
    administrative: 55,
    hostel: 65,
    warden: 70,
    mess: 60,
    room: 35,
    accommodation: 50,
    allotment: 55,
    dining: 45,
    food: 30,
    catering: 50,
    complaint: 35,
    'hostel fee': 55,
    'hostel allotment': 65,
    vacating: 50,
    checkout: 45,
  },
  snippetWeights: {
    campus: 25,
    installation: 30,
    infrastructure: 30,
    hostel: 30,
    warden: 35,
    mess: 25,
    room: 20,
    allotment: 30,
  },
};
```

### 6c. augsd

```js
export default {
  category: 'augsd',
  senderExact: ['augsd'],
  senderContains: ['augsd@', 'augsd.bits-pilani'],
  subjectWeights: {
    'ps-i': 50,
    'ps-1': 50,
    'ps-ii': 50,
    'ps-2': 50,
    'ps-i feedback': 70,
    'ps-1 feedback': 70,
    'semester registration': 60,
    'course registration': 60,
    'add/drop': 50,
    'grade sheet': 60,
    transcript: 60,
  },
  snippetWeights: {},
};
```

### 6d. academics

```js
export default {
  category: 'academics',
  senderContains: ['faculty', 'professor', 'dr.', 'instructor', 'hod', 'department'],
  subjectWeights: {
    exam: 60,
    'mid-sem': 70,
    compre: 70,
    'end-sem': 65,
    assignment: 55,
    tutorial: 50,
    lecture: 45,
    class: 35,
    timetable: 60,
    'academic calendar': 65,
    marks: 55,
    grading: 50,
    quiz: 50,
    test: 40,
    sessional: 55,
    'project submission': 60,
    lab: 40,
    practical: 40,
    course: 35,
    syllabus: 55,
    curriculum: 55,
    presentation: 30,
    viva: 60,
    attendance: 50,
    bonus: 40,
    regulation: 45,
    ordinance: 50,
    huel: 75,
    huelp: 75,
    opel: 75,
    cdc: 60,
    erp: 50,
  },
  snippetWeights: {
    exam: 30,
    assignment: 25,
    lecture: 25,
    submission: 20,
    ' marks': 20,
    faculty: 20,
    course: 15,
  },
};
```

### 6e. clubs

```js
export default {
  category: 'clubs',
  senderContains: [
    'club',
    'society',
    'chapter',
    'association',
    'forum',
    'arbits',
    'astro',
    'bitsmun',
    'coding club',
    'comedy hub',
    'comhub',
    'communo',
    'consulting club',
    'bpcc',
    'crac',
    'creative activities',
    'cubing',
    'dance club',
    'debating',
    'embryo',
    'elas',
    'english press',
    'fmac',
    'fashion club',
    'fitbits',
    'gaming club',
    'gdsc',
    'google developer student',
    'gurukul',
    'hindi activities',
    'has.pilani',
    'hindi drama',
    'hdc.pilani',
    'hindi press',
    'hpc.pilani',
    'kalamvansh',
    'karaoke',
    'kc.pilani',
    'mac.pilani',
    'matrix.pilani',
    'media relations',
    'mrc.pilani',
    'mime club',
    'music club',
    'nss.pilani',
    'national service scheme',
    'nirmaan',
    'operations and strategies',
    'parc.pilani',
    'atamnirbhar',
    'photography club',
    'photog',
    'poetry club',
    'postman lab',
    'product management',
    'pm.pilani',
    'public policy club',
    'ppc.pilani',
    'quant club',
    'radioaktiv',
    'renewable energy',
    'sac.pilani',
    'students academic cell',
    'sovesa',
    'spic macay',
    'sarc.pilani',
    'students alumni relations',
    'tedx',
    'eastern outlook',
    'toastmasters',
    'biological association',
    'chemical engineering association',
    'chemistry association',
    'civil engineering association',
    'computer science association',
    'eee association',
    'economics and finance',
    'humanities association',
    'instrumentation forum',
    'manufacturing engineering',
    'mathematics association',
    'mechanical engineering association',
    'pharmacy association',
    'physics association',
    'bits pilani association',
    'andhra samiti',
    'capitol',
    'gurjari',
    'haryana cultural',
    'kairali',
    'udgam',
    'kannada vedike',
    'madhyansh',
    'maharashtra mandal',
    'maurya vihar',
    'moruchhaya',
    'punjab cultural',
    'sangam',
    'tamil mandram',
    'utkal samaj',
    'share.pilani',
    'ifsa',
    'acm.pilani',
    'ieee.pilani',
    'asme',
    'ai-che',
    'ii-che',
    'acm-w',
    'anant',
    'ikr',
    'gravity.pilani',
    'electric.pilani',
    'radio control',
    'robocon',
    'team bits',
    'sally robotics',
    'criss',
    'kxr lab',
    'sutt',
    'cel.pilani',
    'entrepreneurship and leadership',
    'pilani innovation',
    'ieds',
    '180dc',
    'wall street club',
  ],
  subjectWeights: {
    recruitment: 50,
    audition: 60,
    induction: 55,
    meeting: 30,
    'general body': 55,
    club: 40,
    society: 40,
    chapter: 40,
    association: 40,
    sig: 50,
    'student interest group': 60,
    member: 25,
    team: 20,
    'core team': 45,
    event: 15,
    annual: 15,
    workshop: 20,
    session: 15,
    'open house': 40,
    'treasure hunt': 50,
    'hack night': 45,
    'film screening': 45,
    'jam session': 45,
    'open mic': 50,
    concert: 40,
    exhibition: 35,
    competition: 35,
    quiz: 40,
    'coding contest': 45,
    debate: 50,
    'moot court': 50,
    'model un': 55,
    'fashion show': 50,
    'dance performance': 45,
    'music performance': 45,
    'nukkad natak': 55,
    'street play': 50,
    'poster making': 40,
    'photography contest': 45,
    'film making': 45,
    'product management': 50,
    consulting: 40,
    finance: 35,
    'public policy': 50,
    quant: 40,
    toastmasters: 50,
    tedx: 55,
    'ted talk': 55,
    alumni: 35,
    nss: 45,
    nirmaan: 50,
    sovesa: 50,
    'spic macay': 55,
    gurukul: 45,
    kalamvansh: 50,
    embryo: 50,
    communo: 50,
    arbits: 50,
    bitsmun: 55,
    fitbits: 45,
    radioaktiv: 50,
    'andhra samiti': 45,
    gurjari: 45,
    kairali: 45,
    udgam: 45,
    'tamil mandram': 45,
    'maharashtra mandal': 45,
    'punjab cultural': 45,
    'utkal samaj': 45,
    'kannada vedike': 45,
    madhyansh: 45,
    'maurya vihar': 45,
    moruchhaya: 45,
    sangam: 40,
    capitol: 40,
    'haryana cultural': 45,
    acm: 50,
    ieee: 50,
    asme: 50,
    ifsa: 50,
    share: 40,
    'acm-w': 50,
    robocon: 55,
    'sally robotics': 50,
    anant: 45,
    ikr: 45,
    gravity: 40,
    'radio control': 45,
    'kxr lab': 45,
    criss: 40,
    sutt: 40,
    '180dc': 50,
    'wall street club': 55,
    cel: 45,
    entrepreneurship: 45,
    ieds: 50,
  },
  snippetWeights: {
    club: 25,
    society: 25,
    association: 25,
    chapter: 20,
    forum: 20,
    recruitment: 30,
    member: 20,
    join: 20,
    audition: 30,
    induction: 25,
    'general body': 30,
    sig: 25,
    'student interest group': 30,
    'core team': 25,
    event: 15,
    rehearsal: 20,
    practice: 15,
    'annual day': 25,
    fest: 20,
    'open mic': 25,
    concert: 20,
    debate: 25,
    hack: 20,
    coding: 20,
    photography: 20,
    fashion: 20,
    dance: 20,
    music: 20,
    drama: 20,
    poetry: 20,
    film: 15,
    tedx: 25,
    ted: 20,
    alumni: 20,
    nss: 20,
    nirmaan: 25,
    sovesa: 25,
    gurukul: 20,
    bitsmun: 25,
    toastmasters: 25,
    'public policy': 25,
    consulting: 20,
    finance: 15,
    quant: 20,
    product: 15,
    regional: 20,
    cultural: 20,
    'tech team': 20,
    robotics: 20,
    ieee: 25,
    acm: 25,
    asme: 25,
    ifsa: 25,
    robocon: 25,
    entrepreneurship: 20,
    innovation: 15,
    'wall street': 25,
    '180dc': 25,
    cel: 20,
    samiti: 20,
    mandal: 20,
    mandram: 20,
    vedike: 20,
    vihar: 15,
  },
};
```

### 6f. competitions

```js
export default {
  category: 'competitions',
  senderContains: ['hackathon', 'contest', 'competition'],
  subjectWeights: {
    hackathon: 80,
    hack: 50,
    competition: 60,
    'case competition': 80,
    'case study': 60,
    coding: 55,
    'coding contest': 75,
    'programming contest': 75,
    quiz: 40,
    'quiz competition': 65,
    challenge: 55,
    'tech challenge': 70,
    pitch: 50,
    pitching: 55,
    ideathon: 70,
    ideate: 50,
    hackfest: 80,
    hackweek: 80,
    grid: 60,
    'flipkart grid': 80,
    'optum hackathon': 80,
    'axis moves': 70,
    'axis-case': 70,
    smartprix: 70,
    zerodha: 70,
    rubix: 70,
    'code red': 70,
    aerotrix: 70,
    aerothon: 70,
    enumerate: 70,
    byteverse: 70,
    olympiad: 75,
    'math olympiad': 80,
    'science olympiad': 80,
  },
  snippetWeights: {
    hackathon: 40,
    competition: 30,
    contest: 35,
    register: 15,
    prize: 25,
    participate: 20,
  },
};
```

### 6g. events

```js
export default {
  category: 'events',
  senderContains: [
    'oasis',
    'apogee',
    'cultural',
    'fest',
    'seminar',
    'workshop',
    'lecture',
    'colloquium',
    'symposium',
    'conference',
    'orientation',
    'embryo',
    'bits embryo',
  ],
  subjectWeights: {
    fest: 60,
    oasis: 80,
    apogee: 80,
    event: 40,
    'guest lecture': 70,
    seminar: 60,
    workshop: 50,
    webinar: 50,
    cultural: 45,
    techno: 40,
    'management fest': 60,
    concert: 50,
    nukkad: 60,
    'pro night': 60,
    exhibition: 40,
    showcase: 35,
    'institute day': 60,
    'annual day': 55,
    techfest: 70,
    'tech fest': 70,
    meeting: 65,
    talk: 55,
    'talk by': 65,
    'fireside chat': 60,
    panel: 50,
    'panel discussion': 60,
    summit: 55,
    conference: 55,
    colloquium: 55,
    'invited talk': 70,
    'public lecture': 65,
    'distinguished lecture': 75,
    'department talk': 65,
    'tech talk': 65,
    'industry talk': 65,
    'alumni talk': 60,
    inauguration: 55,
    valedictory: 55,
    keynote: 55,
    plenary: 50,
    meetup: 50,
    roundtable: 50,
    'open house': 50,
    'demo day': 55,
    'seminar series': 65,
    'talk series': 65,
    'lecture series': 65,
    'training session': 50,
    'orientation session': 55,
    orientation: 55,
    'information session': 50,
    'town hall': 60,
    convocation: 60,
    'community meeting': 60,
    'department meeting': 55,
    'faculty meeting': 55,
    'committee meeting': 55,
    'board meeting': 55,
    'council meeting': 55,
    agenda: 55,
    discussion: 50,
    session: 50,
    viva: 55,
    schedule: 50,
    'calendar invite': 60,
    'you are invited': 65,
    presentation: 50,
    'google meet': 60,
    'zoom meeting': 60,
    'teams meeting': 60,
    'join us': 55,
    'please attend': 55,
    'ai talk': 65,
    'ai seminar': 60,
    'machine learning talk': 60,
    'campus event': 55,
    embryo: 60,
  },
  snippetWeights: {
    fest: 30,
    event: 25,
    register: 20,
    workshop: 25,
    seminar: 25,
    meeting: 35,
    talk: 30,
    lecture: 30,
    panel: 20,
    summit: 20,
    conference: 25,
    speaker: 20,
    presentation: 25,
    invite: 20,
    rsvp: 20,
    attend: 20,
    keynote: 20,
    auditorium: 20,
    venue: 20,
    'google meet': 35,
    zoom: 30,
    teams: 30,
    agenda: 25,
    hall: 15,
    date: 15,
    time: 15,
    calendar: 20,
    invited: 20,
    session: 20,
    orientation: 20,
  },
};
```

### 6h. external-promotions

```js
export default {
  category: 'external-promotions',
  senderContains: ['newsletter', 'marketing', 'promo', 'unsubscribe'],
  subjectWeights: {
    newsletter: 60,
    promotion: 65,
    sale: 55,
    offer: 50,
    discount: 55,
    deal: 45,
    'limited time': 50,
    'special offer': 55,
    exclusive: 40,
    subscribe: 45,
    unsubscribe: 30,
    'win': 35,
    'free': 30,
  },
  snippetWeights: {
    newsletter: 30,
    promotion: 35,
    sale: 25,
    offer: 25,
    discount: 25,
    unsubscribe: 20,
  },
};
```

### 6i. external-services

```js
export default {
  category: 'external-services',
  senderContains: ['github', 'openai', 'anthropic', 'kaggle', 'medium', 'substack', 'nvidia', 'huggingface'],
  subjectWeights: {
    notification: 50,
    alert: 45,
    update: 40,
    'security': 55,
    'account': 45,
    'verify': 50,
    'password': 55,
    'subscription': 45,
    'invoice': 50,
    'receipt': 50,
    'order': 45,
    'shipment': 50,
  },
  snippetWeights: {
    notification: 25,
    alert: 20,
    account: 25,
    security: 30,
    verify: 25,
  },
};
```

### 6j. internship

```js
export default {
  category: 'internship',
  senderExact: ['placement unit', 'training and placement', 'tpo', 'placement office'],
  senderContains: ['placement', 'training-and-placement'],
  subjectWeights: {
    placement: 70,
    'pre-placement': 80,
    ppt: 75,
    'pre-placement talk': 85,
    ppi: 80,
    ppo: 85,
    internship: 65,
    ps1: 60,
    ps2: 60,
    'ps-1': 60,
    'ps-2': 60,
    'summer internship': 80,
    'winter internship': 80,
    recruitment: 60,
    'campus recruitment': 80,
    'job opening': 55,
    'job opportunity': 55,
    'job offer': 60,
    'job alert': 55,
    'job vacancy': 55,
    'job listing': 55,
    'job posting': 55,
    'job fair': 55,
    'job interview': 55,
    'job placement': 60,
    company: 30,
    interview: 40,
    offer: 35,
    dream: 60,
    'super dream': 70,
    'day 1': 60,
    'day 2': 60,
    slot: 40,
    'resume shortlist': 70,
    shortlist: 50,
    hiring: 60,
    apply: 50,
    registration: 45,
    opportunity: 45,
    'industrial training': 60,
    summer: 30,
    winter: 30,
    superset: 70,
    'internship cycle': 70,
  },
  snippetWeights: {
    placement: 40,
    internship: 40,
    recruitment: 35,
    'pre-placement': 45,
    hiring: 35,
    apply: 25,
    'job opening': 30,
    'job opportunity': 30,
    'job offer': 30,
    'job alert': 30,
    opportunity: 25,
    register: 20,
    company: 20,
    'apply now': 25,
  },
};
```

### 6k. library

```js
export default {
  category: 'library',
  senderContains: ['library', 'circulation', 'overdue', 'lending', 'book issue'],
  subjectWeights: {
    library: 60,
    book: 40,
    'due date': 60,
    fine: 50,
    return: 30,
    borrow: 45,
    journal: 40,
    reference: 30,
    'digital library': 55,
    overdue: 55,
    renewal: 40,
    'book issue': 55,
    'book return': 55,
    circulation: 50,
    'book due': 55,
    'late fine': 55,
  },
  snippetWeights: {
    library: 25,
    book: 20,
    due: 30,
    fine: 30,
    overdue: 30,
    circulation: 25,
    borrow: 20,
    return: 15,
  },
};
```

### 6l. ps

```js
export default {
  category: 'ps',
  senderContains: [
    'psadmin',
    'ps cell',
    'practice school',
    'psdivision',
    'psd',
    'im.psd',
    'instruction & monitoring',
    'instruction and monitoring',
  ],
  senderExact: [
    'ps-i',
    'ps-i cell',
    'ps division',
    'ps department',
    'ps office',
    'ps feedback',
  ],
  subjectWeights: {
    'ps-i': 80,
    ps1: 75,
    'ps-ii': 80,
    ps2: 75,
    'practice school': 85,
    'ps allotment': 80,
    'ps feedback': 85,
    'ps station': 75,
    'ps project': 70,
    'ps report': 70,
    'ps presentation': 70,
    'ps evaluation': 75,
    'ps guide': 65,
    'ps mentor': 65,
    'ps internship': 70,
    'industry practice': 60,
    'ps-i feedback': 90,
    'ps-ii feedback': 90,
    'ps grades': 80,
    'ps grading': 80,
    psms: 85,
    'practice school management system': 80,
    'final report': 65,
    'end semester report': 75,
    'faculty in charge': 70,
    fic: 55,
    mentor: 40,
    'organization mentor': 65,
    'mid sem feedback': 70,
    station: 55,
  },
  snippetWeights: {
    'ps-i': 40,
    'ps-ii': 40,
    'practice school': 45,
    'ps feedback': 45,
    'ps station': 35,
    'ps project': 30,
    'ps report': 30,
    'ps guide': 30,
    feedback: 20,
    'industry training': 25,
  },
};
```

### 6m. spam

```js
export default {
  category: 'spam',
  senderExact: ['noreply', 'no-reply', 'do-not-reply', 'donotreply'],
  senderContains: ['marketing', 'promo', 'ad-', 'ads.', 'sponsored', 'newsletter', 'bulk'],
  subjectWeights: {
    unsubscribe: 60,
    'opt out': 55,
    discount: 50,
    offer: 40,
    'limited time': 50,
    'buy now': 60,
    'free': 30,
    deal: 40,
    promotion: 50,
    advertisement: 55,
    'click here': 50,
    subscribe: 40,
    winner: 60,
    congratulations: 40,
    'you won': 65,
    claim: 45,
    prize: 45,
    reward: 40,
    'exclusive deal': 55,
    'flash sale': 55,
    'black friday': 50,
    'cyber monday': 50,
    'act now': 50,
    hurry: 40,
    'amazing offer': 55,
    'special offer': 50,
    newsletter: 45,
    marketing: 50,
    promo: 45,
    'bulk mail': 55,
    'mailing list': 45,
    'weekly digest': 40,
    'daily digest': 40,
  },
  snippetWeights: {
    unsubscribe: 35,
    marketing: 30,
    promotion: 25,
    offer: 20,
    discount: 25,
    buy: 20,
    newsletter: 25,
    'bulk mail': 25,
    'mailing list': 20,
  },
};
```

### 6n. technology

```js
export default {
  category: 'technology',
  senderContains: [],
  senderExact: [
    'nvidia',
    'openai',
    'anthropic',
    'google ai',
    'deepmind',
    'meta ai',
    'hugging face',
    'kaggle',
    'github',
    'gitlab',
    'vercel',
    'netlify',
    'docker',
    'kubernetes',
    'aws',
    'azure',
    'gcp',
    'arxiv',
    'papers with code',
    'towards data science',
    'medium',
    'substack',
    'dev.to',
    'cursor',
    'supabase',
    'cloudflare',
    'replit',
    'openrouter',
    'base44',
  ],
  subjectWeights: {
    newsletter: 45,
    digest: 45,
    'weekly digest': 55,
    "what's new": 40,
    'release notes': 50,
    'new feature': 45,
    'product update': 50,
    developer: 35,
    'dev update': 50,
    'machine learning': 35,
    llm: 35,
    tutorial: 30,
    'getting started': 30,
    'blog post': 35,
    version: 30,
    changelog: 45,
    claude: 50,
    gpt: 45,
    gemini: 35,
    'open source': 35,
    'open-source': 35,
    cursor: 55,
    supabase: 55,
    cloudflare: 55,
    replit: 55,
  },
  snippetWeights: {
    newsletter: 25,
    release: 20,
    feature: 15,
    tutorial: 15,
  },
};
```

---

## 7. Email Mappings

> Source: `email-mappings/*.json`  
> Note: These JSON files exist in the repo but are **not loaded by the classifier code** at runtime. They are legacy/reference data. Listed here for completeness.

### 7a. admin (37 addresses)

```json
{
  "category": "admin",
  "description": "Mail Admin, IT Services, ERP, Registrar, IPC, Security, Purchases",
  "emails": [
    { "name": "Mail Admin User BITS", "email": "admin@bits-pilani.ac.in" },
    { "name": "admin", "email": "admin@dubai.bits-pilani.ac.in" },
    { "name": "ADMIN WILP", "email": "admin.wilp@hyderabad.bits-pilani.ac.in" },
    { "name": "BITS RMIT Admin", "email": "admin.bitsrmit@pilani.bits-pilani.ac.in" },
    { "name": "Admin 001", "email": "admin001@hyderabad.bits-pilani.ac.in" },
    { "name": "bitspilani-digital-admin-app", "email": "bitspilani-digital-admin-app@bits-pilani-digital.edu.in" },
    { "name": "online-admin-app", "email": "online-admin-app@online.bits-pilani.ac.in" },
    { "name": "pilani-admin-app", "email": "pilani-admin-app@pilani.bits-pilani.ac.in" },
    { "name": "Registrar @ BITS Pilani", "email": "registrar@bits-pilani.ac.in" },
    { "name": "Registrar Office BITS Pilani", "email": "registrar.office@pilani.bits-pilani.ac.in" },
    { "name": "Deputy Registrar BITS Pilani", "email": "dyregistrar@pilani.bits-pilani.ac.in" },
    { "name": "Navin Singh", "email": "navin@pilani.bits-pilani.ac.in" },
    { "name": "Rajesh P Mishra", "email": "rpm@pilani.bits-pilani.ac.in" },
    { "name": "Chief Security Officer BITS Pilani", "email": "cso@pilani.bits-pilani.ac.in" },
    { "name": "Chief Purchases", "email": "chiefpurchases@pilani.bits-pilani.ac.in" },
    { "name": "Unit Chief IT Services", "email": "chief.itservices@pilani.bits-pilani.ac.in" },
    { "name": "IPC Chief", "email": "ipcchief@pilani.bits-pilani.ac.in" },
    { "name": "IPC Helpdesk", "email": "ipchelpdesk@pilani.bits-pilani.ac.in" },
    { "name": "IPC Operator", "email": "ipcoptr@pilani.bits-pilani.ac.in" },
    { "name": "IPC Office", "email": "ipcoffice@pilani.bits-pilani.ac.in" },
    { "name": "IPC LAB BITS", "email": "ipclab@pilani.bits-pilani.ac.in" },
    { "name": "IPC Lab Booking", "email": "ipclabbooking@pilani.bits-pilani.ac.in" },
    { "name": "IPC Testing", "email": "ipctesting@pilani.bits-pilani.ac.in" },
    { "name": "Admission Office BITS Pilani", "email": "ddtr@pilani.bits-pilani.ac.in" },
    { "name": "ERP Head BITS Pilani", "email": "erp.head@bits-pilani.ac.in" },
    { "name": "ERP @ BITS Goa", "email": "erpbitsgoa@goa.bits-pilani.ac.in" },
    { "name": "ERP Gsuite LoginTestAccount", "email": "erpgsuit@goa.bits-pilani.ac.in" },
    { "name": "ERP HEAD", "email": "erp_head@hyderabad.bits-pilani.ac.in" },
    { "name": "ERP Help Desk", "email": "erphelpdesk@bits-pilani.ac.in" },
    { "name": "ERP HR Support", "email": "erphrsupport@goa.bits-pilani.ac.in" },
    { "name": "ERP WILP", "email": "erp_wilp@pilani.bits-pilani.ac.in" },
    { "name": "ERP Head BITS Pilani (Communications)", "email": "communications.erp@pilani.bits-pilani.ac.in" }
  ]
}
```

### 7b. academics (0 addresses)

```json
{
  "category": "academics",
  "description": "Professors, Faculty, Exams, Assignments",
  "emails": []
}
```

### 7c. augsd (8 addresses)

```json
{
  "category": "augsd",
  "description": "Academic Undergraduate Studies Division - AUGSD",
  "emails": [
    { "name": "Associate Dean AUGSD", "email": "ad.augsd@pilani.bits-pilani.ac.in" },
    { "name": "Associate Dean AUGSD (Hyderabad Campus)", "email": "ad.augsd@hyderabad.bits-pilani.ac.in" },
    { "name": "AUGSD BITS Pilani", "email": "dean.augsd@bits-pilani.ac.in" },
    { "name": "AUGSD Pilani", "email": "augsdpilani@pilani.bits-pilani.ac.in" },
    { "name": "AUGSD Apple", "email": "augsdapple@goa.bits-pilani.ac.in" },
    { "name": "Academic - Undergraduate Studies (Hyderabad Campus)", "email": "augsd@hyderabad.bits-pilani.ac.in" },
    { "name": "Academic Undergraduate Studies Division Office (Goa Campus)", "email": "augsd.office@goa.bits-pilani.ac.in" },
    { "name": "ARC Division BITS Pilani, Dubai Campus", "email": "augsd@dubai.bits-pilani.ac.in" }
  ]
}
```

### 7d. administration (74 addresses)

```json
{
  "category": "administration",
  "description": "Director, Dean, VC, Chief Warden, SWD, FIC, Student Governance, CREST/CRENS, International Programs",
  "emails": [
    { "name": "Associate Dean SWD", "email": "ad.swd@pilani.bits-pilani.ac.in" },
    { "name": "Associate Dean WILP (Faculty Affairs)", "email": "associatedean.fad@wilp.bits-pilani.ac.in" },
    { "name": "Associate Dean WILP (Quality)", "email": "associatedean.quality@wilp.bits-pilani.ac.in" },
    { "name": "Associate Dean – Online Programmes", "email": "associatedean@online.bits-pilani.ac.in" },
    { "name": "Associatedean Fad", "email": "associatedean.fad@pilani.bits-pilani.ac.in" },
    { "name": "AssociateDean IPCD", "email": "associatedean.ipcd@pilani.bits-pilani.ac.in" },
    { "name": "Chief Warden", "email": "chiefwarden@pilani.bits-pilani.ac.in" },
    { "name": "Chief Warden (Dubai Campus)", "email": "chiefwarden@dubai.bits-pilani.ac.in" },
    { "name": "Chief Advisor Student Care", "email": "chiefadvisorstudentcare@goa.bits-pilani.ac.in" },
    { "name": "Director Pilani", "email": "director@pilani.bits-pilani.ac.in" },
    { "name": "Director BITS Pilani, K K Birla Goa Campus", "email": "director@goa.bits-pilani.ac.in" },
    { "name": "Director BITS-Pilani Hyderabad Campus", "email": "director@hyderabad.bits-pilani.ac.in" },
    { "name": "Director @ BITS Pilani Dubai Campus", "email": "director@dubai.bits-pilani.ac.in" },
    { "name": "Director's Office BPDC", "email": "director.office@dubai.bits-pilani.ac.in" },
    { "name": "Director (Off-Campus Programmes and Industry Engagement)", "email": "director.offcampus@bits-pilani.ac.in" },
    { "name": "Director BITS FACTT K K Birla Goa", "email": "directorbitsfacttgoa@goa.bits-pilani.ac.in" },
    { "name": "Director's Office (Hyderabad Campus)", "email": "diroff@hyderabad.bits-pilani.ac.in" },
    { "name": "VC BITS Pilani", "email": "vc@bits-pilani.ac.in" },
    { "name": "Prof. Ajit Pratap Singh", "email": "dean.dasfa@bits-pilani.ac.in" },
    { "name": "Dean AGSR", "email": "dean.agsrd@bits-pilani.ac.in" },
    { "name": "Dean Arp", "email": "dean-arp@pilani.bits-pilani.ac.in" },
    { "name": "Dean Research & Innovation BITS Pilani", "email": "dean.ri@bits-pilani.ac.in" },
    { "name": "Dean Administration (Goa Campus)", "email": "deanadmin@goa.bits-pilani.ac.in" },
    { "name": "Dean Administration (Hyderabad Campus)", "email": "deanadmin@hyderabad.bits-pilani.ac.in" },
    { "name": "Sports Financial Committee Pilani Campus", "email": "sfc@pilani.bits-pilani.ac.in" },
    { "name": "SWD Scholarship BITS Pilani", "email": "scholarship.swd@pilani.bits-pilani.ac.in" },
    { "name": "SWD Fees BITS Pilani", "email": "fees.swd@pilani.bits-pilani.ac.in" },
    { "name": "Vinod Kumar SWD BITS Pilani", "email": "vinod.kumar@pilani.bits-pilani.ac.in" },
    { "name": "swd", "email": "swd@dubai.bits-pilani.ac.in" },
    { "name": "Election Commission", "email": "electioncommission@pilani.bits-pilani.ac.in" },
    { "name": "The Election Commission Hyderabad Campus", "email": "electioncommission@hyderabad.bits-pilani.ac.in" },
    { "name": "BSc CS Election Commission", "email": "electioncommission.bsc.cs@online.bits-pilani.ac.in" },
    { "name": "CS Elective", "email": "cs.elective@pilani.bits-pilani.ac.in" },
    { "name": "BPDC Election Commission", "email": "bpdec@dubai.bits-pilani.ac.in" },
    { "name": "BPDC Election Commission 2025", "email": "bpdcec2022@dubai.bits-pilani.ac.in" },
    { "name": "Student Council Election Commission Goa Campus", "email": "bpgcec@goa.bits-pilani.ac.in" },
    { "name": "President Student Union Pilani Campus", "email": "president@pilani.bits-pilani.ac.in" },
    { "name": "President Student Council", "email": "president@dubai.bits-pilani.ac.in" },
    { "name": "President Student Union Hyderabad Campus", "email": "president@hyderabad.bits-pilani.ac.in" },
    { "name": "President - BSc CS Coding Club", "email": "president-codingclub@online.bits-pilani.ac.in" },
    { "name": "President - BSc CS Entrepreneurship Club", "email": "president-entrepreneurshipclub@online.bits-pilani.ac.in" },
    { "name": "Gensec BITS", "email": "gensec@pilani.bits-pilani.ac.in" },
    { "name": "Student Senator", "email": "student.senator@goa.bits-pilani.ac.in" },
    { "name": "Student Senator Pilani Campus", "email": "student.senator@pilani.bits-pilani.ac.in" },
    { "name": "Annual International Management Conference", "email": "aimc@hyderabad.bits-pilani.ac.in" },
    { "name": "BITS Pilani Placements", "email": "internationalplacements@bits-pilani.ac.in" },
    { "name": "BITS Pilani Placements", "email": "internationalplacements@pilani.bits-pilani.ac.in" },
    { "name": "BITS Pilani International Student Admission", "email": "bitsisa2015@pilani.bits-pilani.ac.in" },
    { "name": "BITS-CSP International Collaboration BITS Pilani", "email": "bitscsp.fd@pilani.bits-pilani.ac.in" },
    { "name": "BITS-ISU International Collaboration", "email": "bitsisu.fd@pilani.bits-pilani.ac.in" },
    { "name": "Associate Dean @ International Programmes and Collaborations (Goa)", "email": "ad.ipcd@goa.bits-pilani.ac.in" },
    { "name": "Associate Dean International Programmes & Collaborations (Hyderabad)", "email": "ad.ipcd@hyderabad.bits-pilani.ac.in" },
    { "name": "FIC HD & Ph.D Admissions BITS Pilani", "email": "fic.hd@pilani.bits-pilani.ac.in" },
    { "name": "FIC Students Fests Pilani Campus", "email": "fic.swdfests@pilani.bits-pilani.ac.in" },
    { "name": "FIC @ Academic Counselling and Monitoring", "email": "fic.acm@goa.bits-pilani.ac.in" },
    { "name": "FIC @ Academic Research", "email": "fic.ar@goa.bits-pilani.ac.in" },
    { "name": "FIC @ Academic Research Collaborations", "email": "fic.arc@bits-pilani.ac.in" },
    { "name": "FIC @ Admissions", "email": "fic.admissions@hyderabad.bits-pilani.ac.in" },
    { "name": "FIC @ CC", "email": "fic.ccu@goa.bits-pilani.ac.in" },
    { "name": "FIC @ Central Instrumentation Facility", "email": "fic.cif@hyderabad.bits-pilani.ac.in" },
    { "name": "FIC @ Central Purchase Unit", "email": "fic.cpu@hyderabad.bits-pilani.ac.in" },
    { "name": "FIC @ Central Sophisticated Instrumentation Facility", "email": "fic.csif@goa.bits-pilani.ac.in" },
    { "name": "Center for Research Excellence in Semiconductor Technologies", "email": "crest@bits-pilani.ac.in" },
    { "name": "C-REx BITS Pilani Hyderabad Campus", "email": "crex@hyderabad.bits-pilani.ac.in" },
    { "name": "Create Lab", "email": "createlab@hyderabad.bits-pilani.ac.in" },
    { "name": "Creative Lab BPDC", "email": "creativelab@dubai.bits-pilani.ac.in" },
    { "name": "CRENS @ BITS Pilani", "email": "crens@bits-pilani.ac.in" },
    { "name": "CREST Officer BITS Pilani", "email": "crest.officer@bits-pilani.ac.in" },
    { "name": "Head @ CRENS BITS Pilani", "email": "crens.head@bits-pilani.ac.in" },
    { "name": "Head @ CREST BITS Pilani", "email": "crest.head@bits-pilani.ac.in" }
  ]
}
```

### 7e. clubs (8 addresses)

```json
{
  "category": "clubs",
  "description": "Student clubs, societies, associations",
  "emails": [
    { "name": "Radio Control Club Pilani Campus", "email": "radiocontrol.club@pilani.bits-pilani.ac.in" },
    { "name": "Aeolus (The Drone Racing Club) Hyderabad Campus", "email": "aeolus@hyderabad.bits-pilani.ac.in" },
    { "name": "Aerodynamics Club BPGC", "email": "ic.aero@goa.bits-pilani.ac.in" },
    { "name": "AI Club BITS Pilani", "email": "aiclub@pilani.bits-pilani.ac.in" },
    { "name": "Mathematics Association Pilani Campus", "email": "maths.assoc@pilani.bits-pilani.ac.in" },
    { "name": "Physics Association BITS Pilani", "email": "physics.assoc@pilani.bits-pilani.ac.in" },
    { "name": "Embryo BITS Pilani", "email": "embryo@pilani.bits-pilani.ac.in" },
    { "name": "Embryo Club BITS Pilani Campus", "email": "embryo_notice@pilani.bits-pilani.ac.in" }
  ]
}
```

### 7f. competitions (0 addresses)

```json
{
  "category": "competitions",
  "description": "Hackathons, Coding Contests, Competitions",
  "emails": []
}
```

### 7g. events (0 addresses)

```json
{
  "category": "events",
  "description": "Fests, Seminars, Workshops, Cultural Events",
  "emails": []
}
```

### 7h. external-promotions (0 addresses)

```json
{
  "category": "external-promotions",
  "description": "Marketing, Newsletters, Promotional Emails from External Sources",
  "emails": []
}
```

### 7i. external-services (0 addresses)

```json
{
  "category": "external-services",
  "description": "Account Notifications from GitHub, OpenAI, etc.",
  "emails": []
}
```

### 7j. internship (15 addresses)

```json
{
  "category": "internship",
  "description": "Placement, Training & Placement, PhD TnP",
  "emails": [
    { "name": "Placement Pilani", "email": "placement@pilani.bits-pilani.ac.in" },
    { "name": "Placement Goa", "email": "placement@goa.bits-pilani.ac.in" },
    { "name": "Placement Division", "email": "placement@hyderabad.bits-pilani.ac.in" },
    { "name": "Placement", "email": "placement@dubai.bits-pilani.ac.in" },
    { "name": "Placement Techsupport", "email": "placement.techsupport@hyderabad.bits-pilani.ac.in" },
    { "name": "Placement Goa1", "email": "placementgoa1@goa.bits-pilani.ac.in" },
    { "name": "Placement Goa2", "email": "placementgoa2@goa.bits-pilani.ac.in" },
    { "name": "Placement Goa3", "email": "placementgoa3@goa.bits-pilani.ac.in" },
    { "name": "Training at BITS Hyderabad Campus", "email": "training@hyderabad.bits-pilani.ac.in" },
    { "name": "AI Training BITS Pilani", "email": "aifdp2025@pilani.bits-pilani.ac.in" },
    { "name": "Ph.D Training and Placements", "email": "phdtnp@hyderabad.bits-pilani.ac.in" },
    { "name": "Ph.D. Training and Placement", "email": "phdtn@pilani.bits-pilani.ac.in" },
    { "name": "Ph.D. Training and Placement", "email": "phdtnp@pilani.bits-pilani.ac.in" },
    { "name": "Placement Training Unit", "email": "putraining@pilani.bits-pilani.ac.in" },
    { "name": "Placement Unit Training", "email": "putraining@goa.bits-pilani.ac.in" }
  ]
}
```

### 7k. library (10 addresses)

```json
{
  "category": "library",
  "description": "Library services across all campuses",
  "emails": [
    { "name": "Chief Librarian", "email": "chief.librarian@bits-pilani.ac.in" },
    { "name": "Librarian BITS Pilani", "email": "librarian@pilani.bits-pilani.ac.in" },
    { "name": "Library Pilani Campus", "email": "library@pilani.bits-pilani.ac.in" },
    { "name": "Library Goa Campus", "email": "library@goa.bits-pilani.ac.in" },
    { "name": "Library Hyderabad Campus", "email": "library@hyderabad.bits-pilani.ac.in" },
    { "name": "BPDC Library", "email": "library@dubai.bits-pilani.ac.in" },
    { "name": "Head of Library BPDC", "email": "library-head@dubai.bits-pilani.ac.in" },
    { "name": "Helpdesk Library", "email": "helpdesk.library@pilani.bits-pilani.ac.in" },
    { "name": "No Reply Library", "email": "noreply-library@hyderabad.bits-pilani.ac.in" },
    { "name": "darchive Library Pilani Campus", "email": "darchive@pilani.bits-pilani.ac.in" }
  ]
}
```

### 7l. other (0 addresses)

```json
{
  "category": "other",
  "description": "Fallback for unclassifiable emails",
  "emails": []
}
```

### 7m. ps (9 addresses)

```json
{
  "category": "ps",
  "description": "Practice School Division",
  "emails": [
    { "name": "Associate Dean PSD", "email": "associatedeanpsd@pilani.bits-pilani.ac.in" },
    { "name": "Associate Dean @ Practice School Division (Goa Campus)", "email": "ad.psd@goa.bits-pilani.ac.in" },
    { "name": "Associate Dean @ Practice School Division (Dubai Campus)", "email": "ad.psd@dubai.bits-pilani.ac.in" },
    { "name": "PSD Pilani Campus", "email": "psd@pilani.bits-pilani.ac.in" },
    { "name": "PSD BITS Pilani", "email": "psd.events@goa.bits-pilani.ac.in" },
    { "name": "PS Division Office", "email": "psd@goa.bits-pilani.ac.in" },
    { "name": "Practice School", "email": "psd@hyderabad.bits-pilani.ac.in" },
    { "name": "DIVISION PS", "email": "psd@dubai.bits-pilani.ac.in" },
    { "name": "PSD Webmaster PSDivision BITS Pilani Campus", "email": "psd.webmaster@pilani.bits-pilani.ac.in" }
  ]
}
```

### 7n. spam (0 addresses)

```json
{
  "category": "spam",
  "description": "Promotional Spam, Phishing",
  "emails": []
}
```

### 7o. technology (0 addresses)

```json
{
  "category": "technology",
  "description": "Dev Newsletters, AI/ML Updates, Tech Companies",
  "emails": []
}
```

---

## 8. Pipeline Logic (for implementation)

```text
INPUT: { subject: string, sender: string, snippet: string }

STEP 1 — detectBitsSource(sender)
  Extract email from "From" header (between < >).
  If endsWith any BITS_DOMAIN → isBits = true.

STEP 2 — classifyBySender(sender, isBits)
  For each rule in SENDER_RULES (top-to-bottom):
    If isBits && rule.category starts with "external-" → SKIP
    If !isBits && rule.category NOT starts with "external-" && !== "spam" → SKIP
    For each pattern in rule.patterns:
      If sender.toLowerCase().includes(pattern.toLowerCase()) → RETURN { category, confidence: 0.95 }

  Then check custom sender rules from userSettings.customPatternRules:
    For each rule with senderExact / senderContains → match against email address
    First match wins, confidence 0.9–0.85

STEP 3 — classifyByPattern(emailData, isBits)  [only if Step 2 returned null]
  Filter rules by isBits (same filter as Step 2).
  For each rule:
    score = 0
    If rule.senderExact && email includes any exact → score += 80 * 1.5; hasSenderMatch = true
    If rule.senderContains && email includes any → score += 55 * 1.5; hasSenderMatch = true
    For each keyword in rule.subjectWeights:
      If subject includes keyword:
        First match → score += weight * 1.2
        Subsequent matches → score += weight * 1.2 * 0.6
    For each keyword in rule.snippetWeights:
      If snippet includes keyword:
        First match → score += weight * 1.0
        Subsequent matches → score += weight * 1.0 * 0.6
    If rule.senderPenalty && sender includes penalty → score -= 30

  Sort all rules by score descending.
  resolveConflict(topScored):
    If runnerUp.score >= top.score * 0.9:
      Prefer the one with hasSenderMatch = true
    Return winner

  If best.score <= 0 → RETURN { category: 'other', confidence: 0.3 }
  Else → RETURN { category: best.category, confidence: normalizeConfidence(best.score) }

STEP 4 — normalizeConfidence(rawScore)
  Map rawScore → 0.3–0.98 using the calibration table above.

STEP 5 — applyLabelIfAboveThreshold
  If confidence >= userSetting('confidenceThreshold', default 0.7):
    Apply Gmail label "BITS/{category}" via Gmail API modifyLabels.
```

---

## 9. Built-in Rule Order

> Source: `lib/pattern-classifier/rules/index.js`

```js
export const BUILT_IN_RULES = [
  externalPromotions,
  externalServices,
  internship,
  competitions,
  clubs,
  events,
  augsd,
  academics,
  administration,
  admin,
  ps,
  library,
  technology,
  spam,
];
```

---

## 10. Tunable Constants

```js
MAX_EMAILS_TOTAL         = 200
MAX_EMAILS_PER_CATEGORY  = 100
MAX_PROCESSED_IDS        = 5000
SYNC_INTERVAL_MINUTES    = 5       // user-configurable 1–30
CONFIDENCE_THRESHOLD     = 0.7     // user-configurable 0.1–1.0
GMAIL_BATCH_SIZE         = 50      // list pagination
DETAIL_BATCH_SIZE        = 100     // batch endpoint chunk
MAX_CONCURRENT_CLASSIFICATIONS = 4
EMAIL_FETCH_RETRIES      = 2
FAILED_ID_TTL_MS         = 3600000  // 1 hour
STALE_LOCK_MS            = 600000   // 10 min
HISTORY_MAX_PAGES        = 20
BACKFILL_MIN_EMAILS_PER_CATEGORY = 5
BACKFILL_MAX_MONTHS_BACK = 12
```

---

## 11. Custom Rules Schema (user-editable)

Stored in `userSettings.customPatternRules` (array of objects):

```ts
{
  category: string,           // must be in BITS_CATEGORIES or custom category name
  senderExact: string[],      // exact substring match on sender
  senderContains: string[],   // contains match on sender
  subjectWeights: Record<string, number>,  // keyword → weight
  snippetWeights: Record<string, number>,  // keyword → weight
}
```

Stored in `userSettings.customCategories` (array of objects):

```ts
{
  name: string,    // max 30 chars
  color: string,   // hex color, default '#94a3b8'
}
```

---

## 12. Label Naming Convention

```
BITS/admin
BITS/administration
BITS/augsd
BITS/academics
BITS/ps
BITS/competitions
BITS/clubs
BITS/events
BITS/internship
BITS/library
BITS/technology
BITS/external-promotions
BITS/external-services
BITS/spam
BITS/{customCategoryName}
```

---

*End of full classification data pack.*

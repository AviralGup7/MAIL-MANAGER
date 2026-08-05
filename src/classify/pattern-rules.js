/**
 * Keyword rules — stage 2 input.
 *
 * Shape, matching the old `lib/pattern-classifier/rules/*.js`:
 *   { category, senderExact[], senderContains[], subjectWeights{}, snippetWeights{} }
 *
 * The old version spread these across 14 files totalling ~970 lines. They are
 * consolidated here because they are data, not code, and 14 files of object
 * literals made it impossible to see the whole rule set at once — which is
 * exactly when weights drift out of proportion with each other.
 *
 * WEIGHT SCALE, so future edits stay in proportion:
 *   40  unmistakable    — the word alone almost fixes the category
 *   25  strong          — very likely, but conceivable elsewhere
 *   15  supporting      — pushes a decision, will not make one alone
 *   8   weak            — only meaningful alongside another hit
 *
 * All keys MUST be lowercase; they are tested against a lowercased haystack.
 */

export const PATTERN_RULES = [
  {
    category: 'augsd',
    senderContains: ['augsd', 'academic section'],
    subjectWeights: {
      'course registration': 40,
      registration: 25,
      'add drop': 40,
      'add/drop': 40,
      withdrawal: 25,
      transcript: 25,
      'grade card': 40,
      cgpa: 25,
      'academic calendar': 40,
      timetable: 25,
      'exam schedule': 40,
      'mid semester': 25,
      'comprehensive exam': 40,
      compre: 25,
      makeup: 15,
      'academic undergraduate': 25,
    },
    snippetWeights: {
      'course registration': 25,
      'academic regulations': 15,
      semester: 8,
      deadline: 8,
    },
  },
  {
    category: 'academics',
    senderContains: ['professor', 'faculty', 'hod@', 'department@'],
    subjectWeights: {
      assignment: 25,
      quiz: 25,
      lecture: 25,
      tutorial: 25,
      lab: 15,
      syllabus: 25,
      'class test': 40,
      'guest lecture': 40,
      seminar: 15,
      'project submission': 40,
      viva: 25,
      attendance: 25,
      'course handout': 40,
    },
    snippetWeights: {
      submit: 8,
      deadline: 8,
      classroom: 8,
      'office hours': 15,
    },
  },
  {
    category: 'admin',
    senderContains: ['registrar', 'controller', 'itsupport', 'mailadmin'],
    subjectWeights: {
      'id card': 40,
      'fee payment': 40,
      'fee receipt': 40,
      'no dues': 40,
      bonafide: 40,
      'password reset': 40,
      'account activation': 40,
      'email quota': 40,
      'system maintenance': 25,
      'server downtime': 25,
      circular: 15,
      notification: 8,
    },
    snippetWeights: {
      'kindly note': 8,
      mandatory: 15,
      'last date': 15,
    },
  },
  {
    category: 'administration',
    senderContains: ['dean', 'director', 'warden', 'hostel', 'mess'],
    subjectWeights: {
      'hostel allotment': 40,
      'room allotment': 40,
      'mess bill': 40,
      'mess menu': 25,
      'hostel fee': 40,
      curfew: 25,
      disciplinary: 40,
      'campus notice': 25,
      water: 8,
      electricity: 8,
      maintenance: 15,
      'election commission': 40,
      nomination: 25,
    },
    snippetWeights: {
      hostel: 15,
      warden: 15,
      campus: 8,
    },
  },
  {
    category: 'ps',
    senderContains: ['psd', 'practice school', 'ps cell'],
    subjectWeights: {
      'practice school': 40,
      'ps-1': 40,
      'ps-2': 40,
      'ps i': 25,
      'ps ii': 25,
      'station allotment': 40,
      'ps station': 40,
      'ps preference': 40,
      'ps report': 40,
      'ps evaluation': 40,
      'ps registration': 40,
    },
    snippetWeights: {
      station: 15,
      'practice school': 25,
      allotment: 15,
    },
  },
  {
    category: 'internship',
    senderContains: ['placement', 'tpo', 'training and placement'],
    subjectWeights: {
      internship: 40,
      placement: 40,
      recruitment: 40,
      'job opportunity': 40,
      'campus drive': 40,
      'pre-placement': 40,
      ppo: 25,
      'offer letter': 40,
      'resume submission': 40,
      shortlist: 25,
      'aptitude test': 25,
      'interview schedule': 40,
      'company visit': 25,
      stipend: 25,
      hiring: 25,
    },
    snippetWeights: {
      'apply by': 15,
      eligibility: 15,
      ctc: 15,
      'job description': 15,
    },
  },
  {
    category: 'competitions',
    senderContains: ['hackathon', 'codechef', 'codeforces', 'hackerrank'],
    subjectWeights: {
      hackathon: 40,
      competition: 25,
      contest: 25,
      challenge: 15,
      'coding round': 40,
      leaderboard: 25,
      'prize pool': 40,
      'cash prize': 40,
      participate: 8,
      'register now': 15,
      'case competition': 40,
      olympiad: 40,
      'ideathon': 40,
      datathon: 40,
    },
    snippetWeights: {
      'last date to register': 15,
      winners: 8,
      'prize money': 15,
    },
  },
  {
    category: 'clubs',
    senderContains: ['club', 'society', 'association', 'samiti', 'mandal'],
    subjectWeights: {
      'club recruitment': 40,
      inductions: 40,
      induction: 25,
      'general body meeting': 40,
      gbm: 25,
      workshop: 15,
      'club activity': 40,
      audition: 25,
      'open house': 25,
      orientation: 15,
      'sign up': 8,
      'join us': 8,
    },
    snippetWeights: {
      club: 15,
      members: 8,
      meeting: 8,
    },
  },
  {
    category: 'events',
    senderContains: ['oasis', 'apogee', 'bosm', 'spree'],
    subjectWeights: {
      oasis: 40,
      apogee: 40,
      bosm: 40,
      spree: 40,
      'cultural fest': 40,
      'tech fest': 40,
      'sports fest': 40,
      concert: 25,
      'star night': 40,
      'pronite': 40,
      fest: 15,
      ticket: 15,
      'event registration': 25,
    },
    snippetWeights: {
      fest: 15,
      event: 8,
      performance: 8,
    },
  },
  {
    category: 'library',
    senderContains: ['library', 'librarian', 'circulation'],
    subjectWeights: {
      'book return': 40,
      'book issue': 40,
      overdue: 40,
      'library fine': 40,
      'due date': 25,
      renewal: 25,
      'library card': 40,
      'e-resources': 25,
      journal: 15,
      'reading room': 25,
    },
    snippetWeights: {
      library: 15,
      book: 8,
      return: 8,
    },
  },
  {
    category: 'technology',
    senderContains: ['github', 'gitlab', 'atlassian', 'vercel', 'netlify'],
    subjectWeights: {
      'pull request': 40,
      'merge request': 40,
      'build failed': 40,
      'build passed': 25,
      deployment: 25,
      'security alert': 40,
      dependabot: 40,
      'ci/cd': 25,
      'api key': 25,
      'new release': 25,
      commit: 15,
      repository: 15,
    },
    snippetWeights: {
      repository: 8,
      branch: 8,
      pipeline: 8,
    },
  },
  {
    category: 'external-services',
    senderContains: ['medium.com', 'substack', 'arxiv', 'kaggle'],
    subjectWeights: {
      'your weekly digest': 25,
      'new post': 15,
      'course enrollment': 25,
      certificate: 15,
      'subscription': 15,
      invoice: 25,
      receipt: 15,
    },
    snippetWeights: {
      'view online': 8,
      'manage preferences': 8,
    },
  },
  {
    category: 'external-promotions',
    senderContains: ['newsletter@', 'marketing@', 'promo@', 'offers@'],
    subjectWeights: {
      'limited time': 40,
      'act now': 40,
      'special offer': 40,
      discount: 25,
      sale: 25,
      'exclusive deal': 40,
      'free trial': 25,
      upgrade: 15,
      'last chance': 40,
      '% off': 25,
    },
    snippetWeights: {
      unsubscribe: 8,
      'promotional email': 15,
      'view in browser': 8,
    },
  },
  {
    category: 'spam',
    senderContains: [],
    subjectWeights: {
      'you have won': 40,
      lottery: 40,
      'claim your prize': 40,
      'verify your account immediately': 40,
      'urgent action required': 25,
      'your account will be closed': 40,
      'wire transfer': 40,
      'bitcoin': 25,
      'crypto investment': 40,
      'work from home earn': 40,
    },
    snippetWeights: {
      'click here immediately': 25,
      'send your details': 25,
      'bank account number': 40,
    },
  },
];

/** Lookup by category, built once. */
export const RULES_BY_CATEGORY = (() => {
  const m = new Map();
  for (const r of PATTERN_RULES) m.set(r.category, r);
  return m;
})();

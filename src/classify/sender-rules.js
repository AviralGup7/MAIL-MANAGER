/**
 * Sender-address rules — stage 1 of classification.
 *
 * CARRIED OVER VERBATIM from the previous version's `lib/sender-rules.js`.
 * This file is the single most valuable artifact in the old repository: the
 * club and department lists are hand-curated BITS Pilani knowledge that cannot
 * be inferred, guessed, or scraped. Roughly 200 patterns. Do not "tidy" it.
 *
 * MATCHING: each pattern is a lowercase substring tested against the whole
 * lowercased `From` header (display name AND address). First rule to match
 * wins, top to bottom — so order in this array is precedence.
 *
 * WHY SUBSTRING AND NOT REGEX: every pattern here is a literal. Substring
 * matching is ~10x faster, cannot backtrack catastrophically, and cannot be
 * broken by an unescaped `.` in a domain. The old version got this right.
 *
 * ORDERING RULE: specific before general. `spam` sits last among the BITS
 * rules so a legitimate mail that merely contains the word "spam" is not
 * swallowed; external buckets sit after internal ones so a BITS club mail
 * mentioning "newsletter" still lands in `clubs`.
 */

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
      'augsd',
      'academic section',
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
      'tedxpilani',
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
      'advisory and monitoring',
      // Redundant, kept for fidelity with the source list: `internship` is
      // rule 7 and this is rule 11, so 'placement unit' can never match here.
      // See docs/CLASSIFIER-CORRECTION.md.
      'placement unit',
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
    patterns: ['spam', 'phishing', 'malware'],
  },
];

/**
 * DIVERGENCES FROM THE OLD FILE
 *
 * The order of this array is now EXACTLY the order in
 * CLASSIFICATION_DATA_PACK.md section 4, which is the authoritative export of
 * the old `lib/sender-rules.js`. Precedence is load-bearing and must not be
 * "improved" without evidence.
 *
 *   admin > library > ps > augsd > academics > administration > internship >
 *   external-promotions > external-services > competitions > clubs > events >
 *   spam
 *
 * An earlier pass through this file made four changes on the strength of bug
 * reports that were all wrong. They are recorded in
 * docs/CLASSIFIER-CORRECTION.md and have been reverted. In brief:
 *
 *   - `'placement unit'` appears in both `clubs` and `internship`. This is
 *     redundant, NOT a bug: `internship` is rule 7 and `clubs` is rule 11, so
 *     internship already wins. The duplicate entry is unreachable for that
 *     string. Left in place so this list stays a faithful copy.
 *
 *   - `external-promotions` genuinely does precede `external-services`, and
 *     that is correct. The claim that this sent GitHub notifications to
 *     Promotions was wrong: stage 1 matches the FROM HEADER only, and
 *     `notifications@github.com` contains none of the promotion patterns.
 *     Reordering these two changed real behaviour — `newsletter@substack.com`
 *     moved from Promotions to Services — for no reason. Reverted.
 *
 *   - `'tedxPilani'` is not dead code. The matcher lowercases BOTH sides
 *     (`sender.toLowerCase().includes(pattern.toLowerCase())`), so the capital
 *     P is irrelevant, and a plain `'tedx'` entry sits beside it anyway.
 *
 *   - `'augSD'` and `'Academic Section'` already exist as bare patterns in the
 *     `augsd` rule. They were never only-with-@bits-pilani.
 *
 * The lesson, recorded so it is not repeated: this list's behaviour depends on
 * rule ORDER and on the fact that stage 1 sees only the From header. Neither is
 * visible from reading one rule in isolation.
 */

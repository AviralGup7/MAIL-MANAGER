/**
 * Exact sender address -> category.
 *
 * ===========================================================================
 * GENERATED FILE -- DO NOT EDIT BY HAND
 * ===========================================================================
 * Source:     CLASSIFICATION_DATA_PACK.md section 7
 * Regenerate: node tools/gen-address-map.mjs
 *
 * 152 hand-curated BITS addresses. The data pack records that these
 * "exist in the repo but are NOT loaded by the classifier code at runtime" --
 * they were dead data in the old version. Loading them is the single largest
 * accuracy win available from the pack.
 *
 * WHY THIS RUNS FIRST
 * An exact address admits no ambiguity: ad.swd@pilani.bits-pilani.ac.in IS
 * administration, whatever the subject line says. Substring rules are a
 * heuristic; this is a fact. So it runs ahead of them, at confidence 0.98.
 *
 * WHY A Map AND NOT AN OBJECT
 * Map lookup is O(1) with no prototype chain to walk and no risk of a key
 * like "constructor" or "__proto__" colliding with Object.prototype. The
 * address is attacker-controlled, so that matters.
 */

/** @type {Map<string, string>} lowercased address -> category */
export const ADDRESS_MAP = new Map([
  ['ad.augsd@hyderabad.bits-pilani.ac.in', 'augsd'],
  ['ad.augsd@pilani.bits-pilani.ac.in', 'augsd'],
  ['ad.ipcd@goa.bits-pilani.ac.in', 'administration'],
  ['ad.ipcd@hyderabad.bits-pilani.ac.in', 'administration'],
  ['ad.psd@dubai.bits-pilani.ac.in', 'ps'],
  ['ad.psd@goa.bits-pilani.ac.in', 'ps'],
  ['ad.swd@pilani.bits-pilani.ac.in', 'administration'],
  ['admin.bitsrmit@pilani.bits-pilani.ac.in', 'admin'],
  ['admin.wilp@hyderabad.bits-pilani.ac.in', 'admin'],
  ['admin001@hyderabad.bits-pilani.ac.in', 'admin'],
  ['admin@bits-pilani.ac.in', 'admin'],
  ['admin@dubai.bits-pilani.ac.in', 'admin'],
  ['aeolus@hyderabad.bits-pilani.ac.in', 'clubs'],
  ['aiclub@pilani.bits-pilani.ac.in', 'clubs'],
  ['aifdp2025@pilani.bits-pilani.ac.in', 'internship'],
  ['aimc@hyderabad.bits-pilani.ac.in', 'administration'],
  ['associatedean.fad@pilani.bits-pilani.ac.in', 'administration'],
  ['associatedean.fad@wilp.bits-pilani.ac.in', 'administration'],
  ['associatedean.ipcd@pilani.bits-pilani.ac.in', 'administration'],
  ['associatedean.quality@wilp.bits-pilani.ac.in', 'administration'],
  ['associatedean@online.bits-pilani.ac.in', 'administration'],
  ['associatedeanpsd@pilani.bits-pilani.ac.in', 'ps'],
  ['augsd.office@goa.bits-pilani.ac.in', 'augsd'],
  ['augsd@dubai.bits-pilani.ac.in', 'augsd'],
  ['augsd@hyderabad.bits-pilani.ac.in', 'augsd'],
  ['augsdapple@goa.bits-pilani.ac.in', 'augsd'],
  ['augsdpilani@pilani.bits-pilani.ac.in', 'augsd'],
  ['bitscsp.fd@pilani.bits-pilani.ac.in', 'administration'],
  ['bitsisa2015@pilani.bits-pilani.ac.in', 'administration'],
  ['bitsisu.fd@pilani.bits-pilani.ac.in', 'administration'],
  ['bitspilani-digital-admin-app@bits-pilani-digital.edu.in', 'admin'],
  ['bpdcec2022@dubai.bits-pilani.ac.in', 'administration'],
  ['bpdec@dubai.bits-pilani.ac.in', 'administration'],
  ['bpgcec@goa.bits-pilani.ac.in', 'administration'],
  ['chief.itservices@pilani.bits-pilani.ac.in', 'admin'],
  ['chief.librarian@bits-pilani.ac.in', 'library'],
  ['chiefadvisorstudentcare@goa.bits-pilani.ac.in', 'administration'],
  ['chiefpurchases@pilani.bits-pilani.ac.in', 'admin'],
  ['chiefwarden@dubai.bits-pilani.ac.in', 'administration'],
  ['chiefwarden@pilani.bits-pilani.ac.in', 'administration'],
  ['communications.erp@pilani.bits-pilani.ac.in', 'admin'],
  ['createlab@hyderabad.bits-pilani.ac.in', 'administration'],
  ['creativelab@dubai.bits-pilani.ac.in', 'administration'],
  ['crens.head@bits-pilani.ac.in', 'administration'],
  ['crens@bits-pilani.ac.in', 'administration'],
  ['crest.head@bits-pilani.ac.in', 'administration'],
  ['crest.officer@bits-pilani.ac.in', 'administration'],
  ['crest@bits-pilani.ac.in', 'administration'],
  ['crex@hyderabad.bits-pilani.ac.in', 'administration'],
  ['cs.elective@pilani.bits-pilani.ac.in', 'administration'],
  ['cso@pilani.bits-pilani.ac.in', 'admin'],
  ['darchive@pilani.bits-pilani.ac.in', 'library'],
  ['ddtr@pilani.bits-pilani.ac.in', 'admin'],
  ['dean-arp@pilani.bits-pilani.ac.in', 'administration'],
  ['dean.agsrd@bits-pilani.ac.in', 'administration'],
  ['dean.augsd@bits-pilani.ac.in', 'augsd'],
  ['dean.dasfa@bits-pilani.ac.in', 'administration'],
  ['dean.ri@bits-pilani.ac.in', 'administration'],
  ['deanadmin@goa.bits-pilani.ac.in', 'administration'],
  ['deanadmin@hyderabad.bits-pilani.ac.in', 'administration'],
  ['director.offcampus@bits-pilani.ac.in', 'administration'],
  ['director.office@dubai.bits-pilani.ac.in', 'administration'],
  ['director@dubai.bits-pilani.ac.in', 'administration'],
  ['director@goa.bits-pilani.ac.in', 'administration'],
  ['director@hyderabad.bits-pilani.ac.in', 'administration'],
  ['director@pilani.bits-pilani.ac.in', 'administration'],
  ['directorbitsfacttgoa@goa.bits-pilani.ac.in', 'administration'],
  ['diroff@hyderabad.bits-pilani.ac.in', 'administration'],
  ['dyregistrar@pilani.bits-pilani.ac.in', 'admin'],
  ['electioncommission.bsc.cs@online.bits-pilani.ac.in', 'administration'],
  ['electioncommission@hyderabad.bits-pilani.ac.in', 'administration'],
  ['electioncommission@pilani.bits-pilani.ac.in', 'administration'],
  ['embryo@pilani.bits-pilani.ac.in', 'clubs'],
  ['embryo_notice@pilani.bits-pilani.ac.in', 'clubs'],
  ['erp.head@bits-pilani.ac.in', 'admin'],
  ['erp_head@hyderabad.bits-pilani.ac.in', 'admin'],
  ['erp_wilp@pilani.bits-pilani.ac.in', 'admin'],
  ['erpbitsgoa@goa.bits-pilani.ac.in', 'admin'],
  ['erpgsuit@goa.bits-pilani.ac.in', 'admin'],
  ['erphelpdesk@bits-pilani.ac.in', 'admin'],
  ['erphrsupport@goa.bits-pilani.ac.in', 'admin'],
  ['fees.swd@pilani.bits-pilani.ac.in', 'administration'],
  ['fic.acm@goa.bits-pilani.ac.in', 'administration'],
  ['fic.admissions@hyderabad.bits-pilani.ac.in', 'administration'],
  ['fic.ar@goa.bits-pilani.ac.in', 'administration'],
  ['fic.arc@bits-pilani.ac.in', 'administration'],
  ['fic.ccu@goa.bits-pilani.ac.in', 'administration'],
  ['fic.cif@hyderabad.bits-pilani.ac.in', 'administration'],
  ['fic.cpu@hyderabad.bits-pilani.ac.in', 'administration'],
  ['fic.csif@goa.bits-pilani.ac.in', 'administration'],
  ['fic.hd@pilani.bits-pilani.ac.in', 'administration'],
  ['fic.swdfests@pilani.bits-pilani.ac.in', 'administration'],
  ['gensec@pilani.bits-pilani.ac.in', 'administration'],
  ['helpdesk.library@pilani.bits-pilani.ac.in', 'library'],
  ['ic.aero@goa.bits-pilani.ac.in', 'clubs'],
  ['internationalplacements@bits-pilani.ac.in', 'administration'],
  ['internationalplacements@pilani.bits-pilani.ac.in', 'administration'],
  ['ipcchief@pilani.bits-pilani.ac.in', 'admin'],
  ['ipchelpdesk@pilani.bits-pilani.ac.in', 'admin'],
  ['ipclab@pilani.bits-pilani.ac.in', 'admin'],
  ['ipclabbooking@pilani.bits-pilani.ac.in', 'admin'],
  ['ipcoffice@pilani.bits-pilani.ac.in', 'admin'],
  ['ipcoptr@pilani.bits-pilani.ac.in', 'admin'],
  ['ipctesting@pilani.bits-pilani.ac.in', 'admin'],
  ['librarian@pilani.bits-pilani.ac.in', 'library'],
  ['library-head@dubai.bits-pilani.ac.in', 'library'],
  ['library@dubai.bits-pilani.ac.in', 'library'],
  ['library@goa.bits-pilani.ac.in', 'library'],
  ['library@hyderabad.bits-pilani.ac.in', 'library'],
  ['library@pilani.bits-pilani.ac.in', 'library'],
  ['maths.assoc@pilani.bits-pilani.ac.in', 'clubs'],
  ['navin@pilani.bits-pilani.ac.in', 'admin'],
  ['noreply-library@hyderabad.bits-pilani.ac.in', 'library'],
  ['online-admin-app@online.bits-pilani.ac.in', 'admin'],
  ['phdtn@pilani.bits-pilani.ac.in', 'internship'],
  ['phdtnp@hyderabad.bits-pilani.ac.in', 'internship'],
  ['phdtnp@pilani.bits-pilani.ac.in', 'internship'],
  ['physics.assoc@pilani.bits-pilani.ac.in', 'clubs'],
  ['pilani-admin-app@pilani.bits-pilani.ac.in', 'admin'],
  ['placement.techsupport@hyderabad.bits-pilani.ac.in', 'internship'],
  ['placement@dubai.bits-pilani.ac.in', 'internship'],
  ['placement@goa.bits-pilani.ac.in', 'internship'],
  ['placement@hyderabad.bits-pilani.ac.in', 'internship'],
  ['placement@pilani.bits-pilani.ac.in', 'internship'],
  ['placementgoa1@goa.bits-pilani.ac.in', 'internship'],
  ['placementgoa2@goa.bits-pilani.ac.in', 'internship'],
  ['placementgoa3@goa.bits-pilani.ac.in', 'internship'],
  ['president-codingclub@online.bits-pilani.ac.in', 'administration'],
  ['president-entrepreneurshipclub@online.bits-pilani.ac.in', 'administration'],
  ['president@dubai.bits-pilani.ac.in', 'administration'],
  ['president@hyderabad.bits-pilani.ac.in', 'administration'],
  ['president@pilani.bits-pilani.ac.in', 'administration'],
  ['psd.events@goa.bits-pilani.ac.in', 'ps'],
  ['psd.webmaster@pilani.bits-pilani.ac.in', 'ps'],
  ['psd@dubai.bits-pilani.ac.in', 'ps'],
  ['psd@goa.bits-pilani.ac.in', 'ps'],
  ['psd@hyderabad.bits-pilani.ac.in', 'ps'],
  ['psd@pilani.bits-pilani.ac.in', 'ps'],
  ['putraining@goa.bits-pilani.ac.in', 'internship'],
  ['putraining@pilani.bits-pilani.ac.in', 'internship'],
  ['radiocontrol.club@pilani.bits-pilani.ac.in', 'clubs'],
  ['registrar.office@pilani.bits-pilani.ac.in', 'admin'],
  ['registrar@bits-pilani.ac.in', 'admin'],
  ['rpm@pilani.bits-pilani.ac.in', 'admin'],
  ['scholarship.swd@pilani.bits-pilani.ac.in', 'administration'],
  ['sfc@pilani.bits-pilani.ac.in', 'administration'],
  ['student.senator@goa.bits-pilani.ac.in', 'administration'],
  ['student.senator@pilani.bits-pilani.ac.in', 'administration'],
  ['swd@dubai.bits-pilani.ac.in', 'administration'],
  ['training@hyderabad.bits-pilani.ac.in', 'internship'],
  ['vc@bits-pilani.ac.in', 'administration'],
  ['vinod.kumar@pilani.bits-pilani.ac.in', 'administration'],
]);

/**
 * Look up an exact address. Returns a category or null.
 * @param {string} address already-lowercased bare address
 */
export function lookupAddress(address) {
  if (!address) return null;
  return ADDRESS_MAP.get(address) || null;
}

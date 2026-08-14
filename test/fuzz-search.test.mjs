/**
 * Property sweep over the search compiler and the reply builder
 * (2026-08-14 fuzz hunt, batch 2).
 *
 * parseQuery is a COMPILER: hostile tokens in, a predicate out. The classic
 * failure mode of a compiler is a predicate that throws one message deep
 * into a filter run — with the wreckage blamed on the list. And buildReply
 * runs on whatever the network said a message's headers were, which is any
 * bytes at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, parseQuery, describeQuery, buildReply } from '../src/app/search/query.js';
import { detectNotice } from '../src/app/academic/notices.js';
import { mulberry32, hostileString, hostileValue } from './helpers/fuzz.mjs';

test('tokenize is total and yields only strings', () => {
  const rnd = mulberry32(0x70C5);
  for (let i = 0; i < 2000; i++) {
    let toks;
    try {
      toks = tokenize(hostileString(rnd));
    } catch (err) {
      assert.fail(`tokenize threw: ${err.message}`);
    }
    assert.ok(Array.isArray(toks) && toks.every((t) => typeof t === 'string'));
  }
});

test('parseQuery is total, and its predicates are total over messages', () => {
  const rnd = mulberry32(0x9E11);
  for (let i = 0; i < 1500; i++) {
    /* Bias toward queries that actually parse: real operators plus hostile
       fillings, parens and ORs, so compileFlat AND parseGrouped both run. */
    const q = rnd() < 0.5
      ? hostileString(rnd)
      : ['from:', 'subject:', 'deadline:overdue', 'after:2025-13-99', 'has:attachment', '(', ')', 'OR', '"unclosed', 'is:unread', 'tag:augsd', '-', 'before:tomorrow']
          .filter(() => rnd() < 0.5).join(' ') + ' ' + hostileString(rnd);
    let parsed;
    try {
      parsed = parseQuery(q, 1_700_000_000_000);
    } catch (err) {
      assert.fail(`parseQuery threw on ${JSON.stringify(q).slice(0, 90)}: ${err.message}`);
    }
    assert.ok(parsed && typeof parsed === 'object', 'a parse result exists');
    if (parsed.predicate) {
      /* The predicate must survive the SAME hostile messages the list can
         hold — wrong-typed fields and all. */
      for (let j = 0; j < 8; j++) {
        const msg = {
          from: hostileValue(rnd), subject: hostileValue(rnd),
          snippet: hostileValue(rnd), labels: hostileValue(rnd),
          unread: hostileValue(rnd),
        };
        let verdict;
        try {
          verdict = parsed.predicate(msg);
        } catch (err) {
          assert.fail(`predicate for ${JSON.stringify(q).slice(0, 60)} threw on a message: ${err.message}`);
        }
        assert.ok(typeof verdict === 'boolean', 'predicate answers true or false');
      }
    }
  }
});

test('describeQuery always has words for whatever parsed', () => {
  const rnd = mulberry32(0xD35C);
  for (let i = 0; i < 800; i++) {
    const parsed = parseQuery(hostileString(rnd), 1_700_000_000_000);
    let desc;
    try {
      desc = describeQuery(parsed);
    } catch (err) {
      assert.fail(`describeQuery threw: ${err.message}`);
    }
    /* QUOTED words are the user's own text echoed back ("undefined" queried
       finds mail about undefined) — that is not the defect this hunts. The
       defect shape is an UNQUOTED artifact slipping in from a missing slot,
       so scan only what is NOT inside quotes. Batch 2's first accusation
       here dissolved into exactly this acquittal. */
    const bare = desc.replace(/"[^"]*"/g, '""');
    assert.ok(typeof desc === 'string' && !/NaN|Infinity|undefined/.test(bare),
      `description "${desc}" must read as human words outside the quotes`);
  }
});

test('buildReply: any header soup in, deliverable fields out', () => {
  const rnd = mulberry32(0x81B31);
  for (let i = 0; i < 1500; i++) {
    const body = {
      replyTo: hostileValue(rnd), from: hostileValue(rnd),
      to: rnd() < 0.5 ? hostileString(rnd) : hostileValue(rnd),
      cc: rnd() < 0.5 ? hostileString(rnd) : hostileValue(rnd),
      subject: hostileString(rnd),
      threadId: hostileValue(rnd), messageId: hostileValue(rnd),
      references: hostileValue(rnd),
    };
    const mode = ['reply', 'replyAll', 'forward'][Math.floor(rnd() * 3)];
    let out;
    try {
      out = buildReply(body, hostileString(rnd), mode);
    } catch (err) {
      assert.fail(`buildReply threw: ${err.message} (body ${JSON.stringify(body)?.slice(0, 90)})`);
    }
    assert.ok(typeof out.subject === 'string');
    /* "Re: Re: " is the mark of a broken client — the strip must hold for
       any nesting of re/fwd/fw prefixes the original carried. */
    assert.ok(!/^(re|fwd|fw)\s*:\s*(re|fwd|fw)\s*:/i.test(out.subject),
      `stacked prefix: "${out.subject}"`);
  }
});

test('detectNotice is total over anything the pipeline holds', () => {
  const rnd = mulberry32(0x9071C5);
  for (let i = 0; i < 1200; i++) {
    const msg = rnd() < 0.05 ? hostileValue(rnd) : {
      subject: hostileValue(rnd), snippet: hostileValue(rnd),
      body: hostileValue(rnd), from: hostileValue(rnd),
    };
    let hit;
    try {
      hit = detectNotice(msg, { courses: [hostileString(rnd).slice(0, 12)] });
    } catch (err) {
      assert.fail(`detectNotice threw: ${err.message}`);
    }
    if (hit !== null) {
      assert.ok(typeof hit.kind === 'string' && typeof hit.label === 'string');
      assert.ok(Array.isArray(hit.courses), 'courses stays an array');
      assert.ok(Number.isFinite(hit.confidence) && hit.confidence >= 0 && hit.confidence <= 1);
    }
  }
});

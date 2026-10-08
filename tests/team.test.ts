import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREWS, DEPARTMENTS, DEPARTMENT_ICON, PERSONAL_DEPARTMENTS, TEAM, TEAM_BY_ID, crewTask, teamBrief } from '../src/shared/team.ts';
import { BRIEFS } from '../src/shared/roster.ts';
import * as shipped from '../src/shared/roster.default.ts';
import type { Crew, Teammate } from '../src/shared/roster-types.ts';
import { STATION_AGENT } from '../src/shared/layout.ts';
import { edition } from '../src/shared/edition.ts';
import { CLAUDE_MODEL_IDS, isAgentEffort, isClaudeModel } from '../src/shared/protocol.ts';

// Checked against the roster the office runs on (your roster.local.ts, if you have one) and against
// the generic one that ships, so a private roster never hides a broken default.
const ROSTERS: { label: string; departments: readonly string[]; icons: Record<string, string>; team: readonly Teammate[]; crews: readonly Crew[] }[] = [
  { label: 'the roster in use', departments: DEPARTMENTS, icons: DEPARTMENT_ICON, team: TEAM, crews: CREWS },
  { label: 'the shipped roster', departments: shipped.DEPARTMENTS, icons: shipped.DEPARTMENT_ICON, team: shipped.TEAM, crews: shipped.CREWS },
];

for (const r of ROSTERS) {
  test(`${r.label}: every teammate has a unique id and a name that says what they do`, () => {
    assert.equal(new Set(r.team.map((m) => m.id)).size, r.team.length);
    assert.equal(new Set(r.team.map((m) => m.name)).size, r.team.length);
    for (const m of r.team) {
      assert.match(m.id, /^[a-z0-9-]{1,32}$/);
      assert.ok(!Object.values(STATION_AGENT).some((a) => a.name === m.name), `${m.name} is a board agent`);
      // Short enough for a name tag, and something a branch name can be made from.
      assert.ok(m.name.length <= 24, `${m.name} is too long for a name tag`);
      assert.match(m.name, /[A-Za-z0-9]/);
      assert.match(m.color, /^#[0-9a-f]{6}$/i);
      assert.ok(m.emoji && m.title && m.pitch && m.focus, `${m.name} is missing a part`);
    }
  });

  test(`${r.label}: every teammate runs on a real model and effort, and judgment roles get Opus`, () => {
    for (const m of r.team) {
      assert.ok(isClaudeModel(m.model), `${m.name} has model ${m.model}`);
      assert.ok(isAgentEffort(m.effort), `${m.name} has effort ${m.effort}`);
      if (/devil's advocate/i.test(m.title)) assert.equal(m.model, 'opus', `${m.name} critiques, so runs on Opus`);
    }
    assert.ok(r.team.some((m) => m.model === 'opus'));
    // Most of the team isn't on Opus: it's kept for the roles that need it.
    assert.ok(r.team.filter((m) => m.model === 'opus').length < r.team.length / 2);
  });

  test(`${r.label}: every department has an icon and someone in it, and every teammate a department`, () => {
    assert.equal(new Set(r.departments).size, r.departments.length);
    for (const d of r.departments) {
      assert.ok(r.icons[d], `${d} has no icon`);
      assert.ok(r.team.some((m) => m.group === d), `${d} is empty`);
    }
    for (const m of r.team) assert.ok(r.departments.includes(m.group), `${m.name} is in ${m.group}, which isn't a department`);
  });

  test(`${r.label}: every crew is made of real, distinct teammates`, () => {
    const ids = new Set(r.team.map((m) => m.id));
    assert.equal(new Set(r.crews.map((c) => c.id)).size, r.crews.length);
    for (const c of r.crews) {
      assert.equal(new Set(c.members).size, c.members.length, `${c.name} lists someone twice`);
      for (const id of c.members) assert.ok(ids.has(id), `${c.name} has an unknown member ${id}`);
      assert.ok(c.members.length >= 2 && c.members.length <= 16);
    }
  });
}

test('the shipped roster is a full, general team', () => {
  assert.ok(shipped.TEAM.length >= 25 && shipped.TEAM.length <= 40, `${shipped.TEAM.length} teammates`);
  for (const d of ['Leadership', 'Operations', 'Engineering', 'Marketing', 'Sales', 'Finance', 'Research', 'Home & Life', 'Personal Finance']) {
    assert.ok((shipped.DEPARTMENTS as readonly string[]).includes(d), `no ${d}`);
  }
  assert.ok(shipped.BRIEFS.personal.length > 0);
  for (const d of shipped.BRIEFS.personal) assert.match(shipped.BRIEFS.contextFor?.[d] ?? '', /business and personal money never cross/);
  // The reports view offers to hire this one (client/app/views/reports.ts).
  assert.ok(shipped.TEAM.some((m) => m.id === 'reports'));
});

test('a brief names the role, keeps work and personal apart, and ends on the task or a hello', () => {
  for (const m of TEAM) {
    const brief = teamBrief(m, true);
    assert.ok(brief.startsWith(`You're the ${m.name} ${m.emoji}`), `${m.name}'s brief doesn't open with who they are`);
    assert.ok(brief.includes(` on ${BRIEFS.team}, working at a desk in ${edition.name}.`));
    assert.ok(brief.includes(m.focus));
    assert.ok(brief.includes(BRIEFS.sharedMemory) && brief.includes(BRIEFS.rules));
    assert.match(brief, /Your first task:$/);
    assert.match(teamBrief(m, false), /wait for your first task\.$/);
    // A department's own rules reach its people, and nobody else's.
    for (const [d, rules] of Object.entries(BRIEFS.rulesFor ?? {})) assert.equal(brief.includes(rules!), m.group === d, `${m.name} and the ${d} rules`);
  }
  // Someone personal never gets the business's context, and the other way round.
  const personal = TEAM.find((m) => PERSONAL_DEPARTMENTS.has(m.group));
  const business = TEAM.find((m) => !PERSONAL_DEPARTMENTS.has(m.group) && !(BRIEFS.contextFor as Record<string, string> | undefined)?.[m.group]);
  assert.ok(personal && business);
  assert.ok(!teamBrief(personal, true).includes(BRIEFS.context));
  assert.ok(teamBrief(business, true).includes(BRIEFS.context));
});

test('each member of a crew is told who else sat down', () => {
  const crew = CREWS.find((c) => c.members.length >= 3)!;
  const members = crew.members.map((id) => TEAM_BY_ID.get(id)!);
  const task = crewTask('Look at ticket 42.', members[0], members, crew);
  assert.match(task, /^Look at ticket 42\./);
  assert.ok(task.includes(`the ${crew.name} crew`));
  for (const m of members.slice(1)) assert.ok(task.includes(m.name), `${m.name} isn't named`);
  assert.ok(!task.includes(`${members[0].name} (`), 'a member is not listed as their own crewmate');
  assert.equal(crewTask('Solo.', members[0], [members[0]]), 'Solo.');
  assert.equal(CLAUDE_MODEL_IDS.opus, 'claude-opus-5-5');
});

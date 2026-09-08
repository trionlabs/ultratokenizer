'use client';
import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowDown,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Wallet,
  FileCheck2,
  Cpu,
  Landmark,
  Database,
  ShieldCheck,
  Coins,
  ScanSearch,
  Check,
  AlertTriangle,
  Minus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cases, type CaseId } from './scenarios';
import {
  moduleById,
  registryRecords,
  journey,
  buildPhases,
  type ModuleId,
} from './modules';
const icons = {
  client: Wallet,
  evidence: FileCheck2,
  prover: Cpu,
  institution: Landmark,
  registry: Database,
  gate: ShieldCheck,
  token: Coins,
  audit: ScanSearch,
};
type ScenarioId = CaseId | 'revoked' | 'missing-audit';
const extraCases = [
  { id: 'revoked', label: 'Key revoked after proving' },
  { id: 'missing-audit', label: 'Audit package missing' },
] as const;
export default function ModuleBlueprint({
  quiet = false,
}: {
  quiet?: boolean;
}) {
  const [selected, setSelected] = useState<ModuleId>('gate');
  const [step, setStep] = useState<number | null>(null);
  const [scenario, setScenario] = useState<ScenarioId>('today');
  const reduced = useReducedMotion(),
    current = moduleById[selected],
    active = cases.find((c) => c.id === scenario);
  const focused = step === null ? [] : journey[step].modules;
  const stop = scenario === 'revoked' || active?.verdict === 'stop',
    blind = active?.verdict === 'blind';
  const title =
    scenario === 'revoked'
      ? 'An old proof does not authorize a new mint.'
      : scenario === 'missing-audit'
        ? 'Missing evidence cannot pass an audit.'
        : scenario === 'today'
          ? 'The target architecture is defined. Real integrations are pending.'
          : active?.title;
  const description =
    scenario === 'revoked'
      ? 'The proof may remain cryptographically valid, but the gate checks live key revocation and rejects issuance.'
      : scenario === 'missing-audit'
        ? 'Issuance may have happened. The auditor reports missing proof or history separately from cryptographic validity.'
        : active?.detail;
  const outcome =
    scenario === 'revoked'
      ? 'Issuance rejected'
      : scenario === 'missing-audit'
        ? 'Audit: incomplete evidence'
        : scenario === 'today'
          ? 'Integration pending'
          : active?.verdict === 'stop'
            ? 'Issuance rejected'
            : active?.verdict === 'blind'
              ? 'Trust boundary exposed'
              : 'Assumed conditions pass';
  const go = (n: number) => {
    const index = Math.max(0, Math.min(journey.length - 1, n));
    setStep(index);
    setSelected(journey[index].selected);
    setScenario('today');
  };
  const chooseCase = (id: ScenarioId) => {
    setScenario(id);
    setStep(null);
    setSelected(
      id === 'revoked'
        ? 'registry'
        : id === 'missing-audit'
          ? 'audit'
          : id === 'dishonest' || id === 'no-reserve'
            ? 'institution'
            : id === 'delivery' || id === 'bypass'
              ? 'token'
              : 'gate',
    );
  };
  const node = (id: ModuleId, compact = false) => {
    const m = moduleById[id],
      Icon = icons[id];
    return (
      <button
        type="button"
        className={
          'ub-node ' +
          (compact ? 'ub-node-compact ' : '') +
          (selected === id ? 'is-selected ' : '') +
          (focused.includes(id) ? 'is-active' : '')
        }
        onClick={() => setSelected(id)}
        aria-pressed={selected === id}
        aria-controls="module-detail"
      >
        <span className="ub-node-top">
          <span className="ub-number">{m.number}</span>
          <span>{m.zone}</span>
          <Icon size={18} />
        </span>
        <strong>{m.title}</strong>
        <span className="ub-node-copy">{m.short}</span>
        {focused.includes(id) && <span className="ub-active-line" />}
      </button>
    );
  };
  return (
    <section className="ub" aria-label="Ultratokenizer module blueprint">
      <div className="ub-heading">
        <div>
          <span className="ub-kicker">ARCHITECTURE BLUEPRINT</span>
          <h2>8 modules. One issuance decision.</h2>
          <p>
            Select a module to inspect its inputs, state ownership and
            acceptance criteria.
          </p>
        </div>
        <span className="ub-status">
          <span /> Proposed design · not integrated
        </span>
      </div>
      <div className="ub-journey">
        <div className="ub-journey-label">
          <span>TRACE THE FLOW</span>
          <span>
            {step === null ? 'Overview' : `${step + 1} / ${journey.length}`}
          </span>
        </div>
        <div className="ub-steps">
          {journey.map((s, i) => (
            <Button
              key={s.title}
              variant="ghost"
              aria-pressed={step === i}
              onClick={() => go(i)}
            >
              <span>{String(i + 1).padStart(2, '0')}</span>
              {s.title}
            </Button>
          ))}
        </div>
      </div>
      <div className="ub-step-detail">
        <output aria-live="polite">
          {step === null
            ? 'Evidence and institutional authority bind to one request. The chain decides; the user controls the private document.'
            : journey[step].detail}
        </output>
        <div>
          <Button
            variant="ghost"
            size="icon"
            disabled={step === null || step === 0}
            onClick={() => go((step ?? 0) - 1)}
            aria-label="Previous step"
          >
            <ChevronLeft size={18} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={step === journey.length - 1}
            onClick={() => go(step === null ? 0 : step + 1)}
            aria-label="Next step"
          >
            <ChevronRight size={18} />
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setStep(null);
              setScenario('today');
              setSelected('gate');
            }}
          >
            Overview
          </Button>
        </div>
      </div>
      <div className="ub-workspace">
        <div className="ub-map" aria-label="Module map with trust boundaries">
          <div className="ub-zone-title">
            <span>01 / USER CONTROL</span>
            <span>Raw documents stay off-chain</span>
          </div>
          {node('client', true)}
          <div className="ub-connector">
            <ArrowDown size={18} />
            <span>
              One request · amount, recipient, token, chain, rights and policy
            </span>
          </div>
          <div className="ub-branches">
            <div>
              {node('evidence', true)}
              <div className="ub-mini-arrow">
                <ArrowDown size={16} />
                <span>Private witness</span>
              </div>
              {node('prover', true)}
            </div>
            <div className="ub-institution-branch">
              <div className="ub-zone-title">
                <span>INSTITUTION BOUNDARY</span>
              </div>
              {node('institution')}
              <p>The institution owns holder and physical reserve records.</p>
            </div>
          </div>
          <div className="ub-merge" aria-hidden="true">
            <span>Proof + public inputs</span>
            <span>Reservation + permit</span>
          </div>
          <div className="ub-connector">
            <ArrowDown size={18} />
            <span>Both outputs bind to the same request</span>
          </div>
          <div className="ub-zone-title">
            <span>02 / HEDERA EVM</span>
            <span>Live authority + atomic issuance</span>
          </div>
          <div className="ub-gate-row">
            <div>
              {node('registry', true)}
              <div className="ub-registry-arrow">
                <span>Active rules</span>
                <ArrowRight size={18} />
              </div>
            </div>
            {node('gate')}
          </div>
          <div className="ub-connector">
            <ArrowDown size={18} />
            <span>Consume capacity + ATS mint · one chain transaction</span>
          </div>
          {node('token', true)}
          <div className="ub-connector">
            <ArrowDown size={18} />
            <span>Proof + permit + versions + all supply changes</span>
          </div>
          <div className="ub-zone-title">
            <span>03 / INDEPENDENT VERIFICATION</span>
            <span>Independent of the application API</span>
          </div>
          {node('audit', true)}
        </div>
        <aside
          className="ub-inspector"
          id="module-detail"
          aria-label="Selected module details"
        >
          <div className="ub-inspector-top">
            <span>MODULE {current.number} / 08</span>
            <span>Proposed responsibility</span>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={selected}
              initial={{ opacity: 0, y: quiet || reduced ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: quiet || reduced ? 0 : 0.15 }}
            >
              <h3>{current.title}</h3>
              <p className="ub-owner">{current.owner}</p>
              <p className="ub-purpose">{current.purpose}</p>
              <dl>
                <dt>INPUT</dt>
                <dd>{current.input}</dd>
                <dt>OUTPUT</dt>
                <dd>{current.output}</dd>
                <dt>WHO OWNS THE DATA?</dt>
                <dd>{current.state}</dd>
                <dt>REQUIRED GUARD</dt>
                <dd>{current.guard}</dd>
                <dt>FAILURE & RECOVERY</dt>
                <dd>{current.failure}</dd>
              </dl>
              {selected === 'registry' && (
                <div className="ub-registry-list">
                  {registryRecords.map(([name, body]) => (
                    <div key={name}>
                      <code>{name}</code>
                      <p>{body}</p>
                    </div>
                  ))}
                </div>
              )}
              {selected === 'evidence' && (
                <div className="ub-adapter-note">
                  <strong>zkPDF first · zkEmail conditional</strong>
                  <p>
                    Add an email adapter only for a real institutional DKIM
                    approval flow. A DKIM key registry or blueprint catalog does
                    not establish issuer authority.
                  </p>
                </div>
              )}
              <div className="ub-acceptance">
                <Check size={18} />
                <div>
                  <strong>Acceptance criterion</strong>
                  <p>{current.acceptance}</p>
                </div>
              </div>
              <div className="ub-current">
                <strong>Implemented today</strong>
                <p>{current.current}</p>
                <span>Proposed implementation path</span>
                <code>{current.plannedPath}</code>
              </div>
            </motion.div>
          </AnimatePresence>
        </aside>
      </div>
      <section className="ub-test">
        <div className="ub-test-heading">
          <div>
            <span className="ub-kicker">STRESS THE ARCHITECTURE</span>
            <h3>Which module should stop it?</h3>
          </div>
          <label>
            Scenario
            <select
              value={scenario}
              onChange={(e) => chooseCase(e.target.value as ScenarioId)}
            >
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
              {extraCases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <output
          className={'ub-verdict ' + (stop || blind ? 'ub-risk' : '')}
          aria-live="polite"
        >
          <div>
            {stop || blind || scenario === 'missing-audit' ? (
              <AlertTriangle size={22} />
            ) : scenario === 'today' ? (
              <Minus size={22} />
            ) : (
              <Check size={22} />
            )}
            <span>{outcome}</span>
          </div>
          <strong>{title}</strong>
          <p>{description}</p>
          <small>
            Design scenario · no real verification or chain transaction
          </small>
        </output>
      </section>
      <section className="ub-contract">
        <div>
          <span className="ub-kicker">SHARED DATA CONTRACT</span>
          <h3>Every module speaks the same request.</h3>
          <p>
            Fix the reservation reference before proving. Changing a bound value
            between proof, permit and mint must fail validation.
          </p>
        </div>
        <div className="ub-request-fields">
          <code>requestId · action</code>
          <code>chainId · gate · token</code>
          <code>recipient · amount · unit</code>
          <code>issuer · reservationId</code>
          <code>claimCommitment · claimUsageId</code>
          <code>policyVersion · rightsVersion</code>
          <code>nonce · validUntil</code>
        </div>
      </section>
      <section className="ub-plan">
        <div className="ub-section-title">
          <span className="ub-kicker">BUILD ORDER</span>
          <h3>8 modules do not need 8 services.</h3>
          <p>
            Start with one interface, a separate prover process, one institution
            bridge, contracts and an independent audit tool.
          </p>
        </div>
        <div className="ub-phases">
          {buildPhases.map((p) => (
            <article key={p.title}>
              <span>{p.ids}</span>
              <h4>{p.title}</h4>
              <p>{p.body}</p>
              <strong>
                <ArrowRight size={16} />
                {p.exit}
              </strong>
            </article>
          ))}
        </div>
      </section>
      <div className="ub-footnote">
        <p>
          Self-sovereign target: user control of documents, keys and disclosure.
          Institutional issuance and reserve authority remain explicit. Minted
          amount, wallet and transaction time are public in this MVP.
        </p>
        <div>
          <a
            href="https://docs.tokenization-studio.hedera.com/ats/user-guides/roles-and-permissions/"
            target="_blank"
            rel="noreferrer"
          >
            ATS permissions ↗
          </a>
          <a
            href="https://docs.zk.email/architecture/security-considerations"
            target="_blank"
            rel="noreferrer"
          >
            ZK Email trust boundary ↗
          </a>
          <a
            href="https://github.com/privacy-ethereum/zkpdf"
            target="_blank"
            rel="noreferrer"
          >
            zkPDF source ↗
          </a>
        </div>
      </div>
    </section>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import s from './home.module.css';
import { api } from '../lib/api';
import { setAuthToken } from '../lib/session';

export default function HomePage() {
  const router = useRouter();
  const [signInOpen, setSignInOpen]       = useState(false);
  const [signInStep, setSignInStep]       = useState<'email' | 'code'>('email');
  const [signInEmail, setSignInEmail]     = useState('');
  const [signInCode, setSignInCode]       = useState('');
  const [signInLoading, setSignInLoading] = useState(false);
  const [signInError, setSignInError]     = useState<string | null>(null);

  function openSignIn() {
    setSignInStep('email'); setSignInEmail(''); setSignInCode(''); setSignInError(null);
    setSignInOpen(true);
  }

  async function handleRequestCode() {
    const email = signInEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    setSignInLoading(true); setSignInError(null);
    try {
      await api.requestCode(email);
      setSignInStep('code');
    } catch (e: unknown) {
      setSignInError(e instanceof Error ? e.message : 'Failed to send code.');
    } finally {
      setSignInLoading(false);
    }
  }

  async function handleVerifyCode() {
    const email = signInEmail.trim().toLowerCase();
    const code  = signInCode.trim();
    if (!code) return;
    setSignInLoading(true); setSignInError(null);
    try {
      const { token } = await api.verifyCode(email, code);
      setAuthToken(token);
      router.push('/workspaces');
    } catch (e: unknown) {
      setSignInError(e instanceof Error ? e.message : 'Invalid code.');
      setSignInLoading(false);
    }
  }

  return (
    <div className={s.page}>
      {/* ── Nav ── */}
      <nav className={s.nav}>
        <div className={s.navInner}>
          <Link href="/" className={s.navBrand}>
            <span className={s.brandMark} aria-hidden />
            <span className="name" style={{ fontWeight: 600, letterSpacing: '0.08em', fontSize: 14, fontFamily: 'var(--mono)' }}>FOIALENS</span>
          </Link>
          <div className={s.navLinks}>
            <a href="#how">How it works</a>
            <a href="#features">Capabilities</a>
            <a href="#evidence">Evidence</a>
            <a href="#security">Security</a>
          </div>
          <div className={s.navSpacer} />
          <div className={s.navCta}>
            <button className={s.navLogin} onClick={openSignIn}>Sign in</button>
            <Link href="/workspaces" className={`${s.btn} ${s.btnAmber} ${s.btnSm}`}>Open workspace →</Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <header className={s.hero} id="top">
        <div className={s.heroGrid}>
          <div className={s.heroCopy}>
            <span className={s.eyebrow}>Investigative workspace for newsrooms</span>
            <h1>Find the story buried in the <span className={s.hl}>document dump</span>.</h1>
            <p className={s.heroSub}>
              FOIALens reads an entire records release — PDFs, scanned filings, and email exports — and surfaces ranked, evidence-backed story angles. Every claim is cited to the source page.
            </p>
            <div className={s.heroActions}>
              <Link href="/workspaces" className={`${s.btn} ${s.btnAmber}`}>Open the workspace →</Link>
              <a href="#how" className={s.btn}>See how it works</a>
            </div>
            <p className={s.heroNote}>
              Upload a corpus and have a ranked, cited lead list in minutes.
            </p>
          </div>

          {/* decorative workspace mock */}
          <div className={s.mock} aria-hidden="true">
            <div className={s.mockBar}>
              <span className={s.dot3}><i /><i /><i /></span>
              <span className={s.crumb}>FOIALENS / <b>Epstein Files — DOJ Release</b></span>
              <span className={s.spacer} />
              <span>CASE-0001</span>
            </div>
            <div className={s.mockStream}>
              <span className={s.live}><span className={s.liveDot} />LIVE</span>
              <span className={s.sep}>·</span>
              <span>phase: <code>cross-doc verification</code></span>
              <span className={s.sep}>·</span>
              <span>4 / 6 angles</span>
            </div>
            <div className={s.mockCards}>
              <div className={`${s.mcard} ${s.pin}`} style={{ animationDelay: '.05s' }}>
                <div className={s.mcardTop}>
                  <span className={s.mcardId}>A-003</span>
                  <span className={s.pinflag}>★ PINNED</span>
                </div>
                <div className={s.mcardH}>Stanford affiliate named in Epstein correspondence</div>
                <div className={s.mcardMeta}>
                  <span className={`${s.badge} ${s.sevHigh}`}>● High</span>
                  <span className={`${s.badge} ${s.badgeType}`}>Relationship</span>
                  <span className={`${s.badge} ${s.badgeConf}`}>CONF <b>0.89</b></span>
                </div>
                <div className={s.mcardRefs}>
                  <span>epstein_doe_31.pdf</span><span className={s.pg}>p.3, 17</span>
                </div>
              </div>

              <div className={s.mcard} style={{ animationDelay: '.32s' }}>
                <div className={s.mcardTop}>
                  <span className={s.mcardId}>A-007</span>
                  <span>PROPOSED</span>
                </div>
                <div className={s.mcardH}>Repeated contact documented across multiple releases</div>
                <div className={s.mcardMeta}>
                  <span className={`${s.badge} ${s.sevHigh}`}>● High</span>
                  <span className={`${s.badge} ${s.badgeType}`}>Timeline</span>
                  <span className={`${s.badge} ${s.badgeConf}`}>CONF <b>0.82</b></span>
                </div>
                <div className={s.mcardRefs}>
                  <span>epstein_doe_57.pdf</span><span className={s.pg}>p.8, 24, 41</span>
                </div>
              </div>

              <div className={s.mcard} style={{ animationDelay: '.62s' }}>
                <div className={s.mcardTop}>
                  <span className={s.mcardId}>A-011</span>
                  <span>PROPOSED</span>
                </div>
                <div className={s.mcardH}>Institutional affiliation listed in travel records</div>
                <div className={s.mcardMeta}>
                  <span className={`${s.badge} ${s.sevMed}`}>● Medium</span>
                  <span className={`${s.badge} ${s.badgeType}`}>Person</span>
                  <span className={`${s.badge} ${s.badgeConf}`}>CONF <b>0.71</b></span>
                </div>
                <div className={s.mcardRefs}>
                  <span>epstein_doe_31.pdf</span><span className={s.pg}>p.29</span>
                </div>
              </div>

              <div className={`${s.mcard} ${s.skel}`} style={{ animationDelay: '.9s' }}>awaiting angle…</div>
            </div>
          </div>
        </div>
      </header>

      {/* ── Ingest strip ── */}
      <div className={s.strip}>
        <div className={s.stripInner}>
          <span className={s.stripLbl}>Ingests</span>
          <span className={s.fmt}>PDF</span>
          <span className={s.sep}>·</span>
          <span>OCR for scanned &amp; photographed pages</span>
          <span className={s.sep}>·</span>
          <span>hybrid semantic + keyword search</span>
        </div>
      </div>

      {/* ── How it works ── */}
      <section className={s.section} id="how">
        <div className={s.wrap}>
          <div className={s.sectionHead}>
            <span className={s.eyebrow}>How it works</span>
            <h2>From a records release to reportable leads.</h2>
            <p>FOIALens reasons over the whole corpus, proposes the angles worth chasing, and shows you exactly where each one came from.</p>
          </div>

          <div className={s.steps}>
            <div className={s.step}>
              <span className={s.stepN}>01</span>
              <h3>Ingest the corpus</h3>
              <p>Drop in the entire release. FOIALens indexes and OCRs every document — contracts, minutes, email exports, invoice tables — and resolves the people and organizations across all of them.</p>
              <div className={s.stepTag}>Upload PDFs directly · OCR for scanned pages</div>
            </div>
            <div className={s.step}>
              <span className={s.stepN}>02</span>
              <h3>Run the investigation</h3>
              <p>Describe what you&apos;re chasing, or let it run open-ended. The model chunks the corpus, drafts candidate angles, and streams them in as evidence is cross-checked across documents.</p>
              <div className={s.stepTag}>Directed &amp; open-ended modes · <b>angles stream live</b></div>
            </div>
            <div className={s.step}>
              <span className={s.stepN}>03</span>
              <h3>Verify at the source</h3>
              <p>Every angle links to the exact page, with the cited passage highlighted. Pin the strong ones, dismiss the noise, and interrogate any lead in a thread alongside the documents.</p>
              <div className={s.stepTag}>Page-level citations · <b>pin · dismiss · thread</b></div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Capabilities ── */}
      <section className={s.section} id="features" style={{ paddingTop: 0 }}>
        <div className={s.wrap}>
          <div className={s.sectionHead}>
            <span className={s.eyebrow}>In the workspace</span>
            <h2>Everything you need to work a lead.</h2>
            <p>One workspace per case — angles, the people behind them, the sequence of events, and a full record of conclusions were reached.</p>
          </div>

          <div className={s.features}>
            <div className={s.feature}>
              <span className={s.ficon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M4 5h16M4 12h16M4 19h9" /><path d="M19 16l2 2-2 2" strokeWidth="1.6" />
                </svg>
              </span>
              <h3>Story angles</h3>
              <p>Candidate leads ranked by severity and model confidence — financial, conflict-of-interest, timeline, and pattern angles surfaced from the record.</p>
            </div>
            <div className={s.feature}>
              <span className={s.ficon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <rect x="5" y="3" width="14" height="18" /><path d="M8 8h8M8 12h8M8 16h5" />
                </svg>
              </span>
              <h3>Cited evidence</h3>
              <p>Each angle carries verbatim quotes and the figures behind it. Click any reference to jump straight to the source page with the passage highlighted.</p>
            </div>
            <div className={s.feature}>
              <span className={s.ficon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <circle cx="8" cy="8" r="3" /><path d="M3 20c0-3 2.5-5 5-5s5 2 5 5" />
                  <circle cx="17" cy="10" r="2.4" /><path d="M14.5 20c0-2.3 1.5-3.6 3-3.6 1.2 0 2 .7 2.5 1.6" />
                </svg>
              </span>
              <h3>Entity resolution</h3>
              <p>People and organizations are tracked across every document, with mention counts and context so the recurring players are obvious at a glance.</p>
            </div>
            <div className={s.feature}>
              <span className={s.ficon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M5 4v16" /><circle cx="5" cy="8" r="1.6" fill="currentColor" />
                  <circle cx="5" cy="15" r="1.6" fill="currentColor" /><path d="M8 8h11M8 15h7" />
                </svg>
              </span>
              <h3>Timeline</h3>
              <p>Dated events assembled from across the corpus into one sequence — so an approval, a payment, and a recusal line up the way they actually happened.</p>
            </div>
            <div className={s.feature}>
              <span className={s.ficon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M4 5h16v11H9l-4 3z" /><path d="M8 9h8M8 12h5" />
                </svg>
              </span>
              <h3>Threads</h3>
              <p>Interrogate any angle in a chat docked to the case. Ask for the signatory, request a cross-reference, or push back — answers stay cited to source pages.</p>
            </div>
            <div className={s.feature}>
              <span className={s.ficon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" /><path d="M9 12l2 2 4-4" />
                </svg>
              </span>
              <h3>Trace</h3>
              <p>A full audit log of every run — prompts, model, chunks examined, and how each angle was scored. Defensible reporting, on the record.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Evidence proof ── */}
      <section className={s.section} id="evidence" style={{ paddingTop: 0 }}>
        <div className={s.wrap}>
          <div className={s.proof}>
            <div className={s.proofCopy}>
              <span className={s.eyebrow}>Cited, not generated</span>
              <h2>Nothing is asserted without a page behind it.</h2>
              <p>Every angle opens to its evidence: the exact quotes, the figures, and the documents they came from. Click through to verify yourself.</p>
              <ul className={s.proofList}>
                <li>
                  <span className={s.proofKey}>→</span>
                  <span><b>Verbatim quotes</b> <span className={s.proofDim}>pulled with page and document, never paraphrased away from the source.</span></span>
                </li>
                <li>
                  <span className={s.proofKey}>→</span>
                  <span><b>Cross-document checks</b> <span className={s.proofDim}>flag when a memo, a minute, and an invoice disagree.</span></span>
                </li>
                <li>
                  <span className={s.proofKey}>→</span>
                  <span><b>Confidence scoring</b> <span className={s.proofDim}>so you know which leads are solid and which need another pass.</span></span>
                </li>
              </ul>
            </div>

            <div className={s.insp}>
              <div className={s.inspHead}>
                <div className={s.inspId}><span>A-003</span><span>·</span><span>HIGH · CONF 0.91</span></div>
                <h4>Council member voted on contract tied to campaign donor</h4>
                <div className={s.inspRow}>
                  <span className={`${s.badge} ${s.sevHigh}`}>● High</span>
                  <span className={`${s.badge} ${s.badgeType}`}>Conflict of Interest</span>
                  <span className={`${s.badge} ${s.badgeConf}`}>CONF <b>0.91</b></span>
                </div>
              </div>
              <div className={s.inspSec}>
                <h5>Evidence</h5>
                <div className={s.ev}>
                  <div className={s.evSrc}>p.4 · cc_minutes_2024_03.pdf</div>
                  <div className={s.evQuote}>Council member Reyes cast deciding vote approving $2.1M infrastructure contract to Meridian Group.</div>
                </div>
                <div className={s.ev}>
                  <div className={s.evSrc}>p.11 · campaign_filings_2023.pdf</div>
                  <div className={s.evQuote}>Meridian Group principal listed as $8,500 contributor to Reyes re-election committee, October 2023.</div>
                </div>
              </div>
              <div className={s.inspSec}>
                <h5>Entities</h5>
                <div className={s.chipRow}>
                  <span className={`${s.chip} ${s.chipOrg}`}>Palo Alto City Council</span>
                  <span className={`${s.chip} ${s.chipPerson}`}>Council Member Reyes</span>
                  <span className={`${s.chip} ${s.chipOrg}`}>Meridian Group</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Security ── */}
      <section className={`${s.section} ${s.security}`} id="security">
        <div className={s.wrap}>
          <div className={s.sectionHead}>
            <span className={s.eyebrow}>Built for the newsroom</span>
            <h2>Sources protected. Work defensible.</h2>
            <p>Investigative material is sensitive by definition. FOIALens is built so the documents — and the people inside them — stay in your control.</p>
          </div>

          <div className={s.secGrid}>
            <div className={s.secItem}>
              <span className={s.siK}>01 / Workspaces</span>
              <h3>Scoped per case</h3>
              <p>Every query is filtered by workspace. Documents, angles, and threads from one investigation are never accessible from another.</p>
            </div>
            <div className={s.secItem}>
              <span className={s.siK}>02 / Audit trail</span>
              <h3>Every run on the record</h3>
              <p>Each investigation logs every tool call, its inputs, and what it returned — a step-by-step record of how conclusions were reached.</p>
            </div>
            <div className={s.secItem}>
              <span className={s.siK}>03 / Deletion</span>
              <h3>Delete anytime, completely</h3>
              <p>Remove a workspace and every document, chunk, angle, and run associated with it is permanently deleted from the database.</p>
            </div>
            <div className={s.secItem}>
              <span className={s.siK}>04 / Open source</span>
              <h3>Deploy it yourself</h3>
              <p>The full stack is open source. Run FOIALens inside your own infrastructure for the most sensitive releases.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className={s.cta}>
        <div className={s.wrap}>
          <span className={s.eyebrow} style={{ justifyContent: 'center' }}>Open a case</span>
          <h2>The lead is in there. Go find it.</h2>
          <div className={s.ctaActions}>
            <Link href="/workspaces" className={`${s.btn} ${s.btnAmber}`}>Open the workspace →</Link>
            <a href="#how" className={s.btn}>See how it works</a>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className={s.footer}>
        <div className={s.footerInner}>
          <div className={s.footerBrand}>
            <span className={s.brandMark} aria-hidden />
            <span>FOIALENS</span>
          </div>
          <span className={s.footerMeta}>Investigative workspace · v0.1.0</span>
          <div className={s.footerSpacer} />
          <div className={s.footerLinks}>
            <a href="#how">How it works</a>
            <a href="#features">Capabilities</a>
            <a href="#security">Security</a>
            <Link href="/workspaces">Open workspace</Link>
          </div>
        </div>
      </footer>

      {signInOpen && (
        <div className="modal-back" onClick={() => setSignInOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-head">
              <h3>{signInStep === 'email' ? 'Sign in' : 'Enter your code'}</h3>
              <button className="btn btn-sm" onClick={() => setSignInOpen(false)}>Close</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {signInStep === 'email' ? (
                <>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-dim)' }}>
                    Enter your email and we&apos;ll send you a 6-digit sign-in code.
                  </p>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={signInEmail}
                    onChange={e => setSignInEmail(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleRequestCode()}
                    autoFocus
                    style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-2)', border: '1px solid var(--border-strong)', color: 'var(--fg)', fontFamily: 'var(--sans)', fontSize: 13, outline: 'none' }}
                  />
                </>
              ) : (
                <>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--fg-dim)' }}>
                    Code sent to <b>{signInEmail}</b>. Check your inbox.
                  </p>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="000000"
                    maxLength={6}
                    value={signInCode}
                    onChange={e => setSignInCode(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={e => e.key === 'Enter' && handleVerifyCode()}
                    autoFocus
                    style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-2)', border: '1px solid var(--border-strong)', color: 'var(--fg)', fontFamily: 'var(--mono)', fontSize: 22, letterSpacing: '0.25em', outline: 'none', textAlign: 'center' }}
                  />
                  <button
                    style={{ background: 'none', border: 'none', padding: 0, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-mute)', cursor: 'pointer', letterSpacing: '0.06em', textAlign: 'left' }}
                    onClick={() => { setSignInStep('email'); setSignInCode(''); setSignInError(null); }}
                  >
                    ← Use a different email
                  </button>
                </>
              )}
              {signInError && (
                <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>{signInError}</p>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setSignInOpen(false)} disabled={signInLoading}>Cancel</button>
              {signInStep === 'email' ? (
                <button className="btn btn-amber" onClick={handleRequestCode} disabled={!signInEmail.trim() || signInLoading}>
                  {signInLoading ? 'Sending…' : 'Send code'}
                </button>
              ) : (
                <button className="btn btn-amber" onClick={handleVerifyCode} disabled={signInCode.length < 6 || signInLoading}>
                  {signInLoading ? 'Verifying…' : 'Sign in'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

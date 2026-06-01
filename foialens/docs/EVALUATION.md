# FOIALens Evaluation

## 1. Recall on a Known-Story Corpus

**Method:** Select a FOIA release where the newsworthy angle is already publicly known — i.e., a release that was already reported on. Run FOIALens on the raw documents without any directed prompt (exploratory mode). Check whether the system independently surfaces the known angle as a proposed story angle.

This tests whether FOIALens finds things a journalist would actually pursue, using ground truth established by real reporting rather than our own judgment.

**Scoring per run:**
- **Hit** — the known angle appears as a proposed angle, with a citation pointing to the correct document/page
- **Partial** — the known angle is implied or adjacent but not directly proposed, or proposed without a usable citation
- **Miss** — the known angle does not appear in any proposed angle

**Corpora under evaluation:**

| Corpus | Known story | Source | Result |
|--------|-------------|--------|--------|
| | | | |

**Results:**

*(to be filled in)*

**Observations:**

*(to be filled in)*

---

## 2. User Feedback — The Stanford Daily

FOIALens was presented to staff at The Daily. Participants were shown a live demo of the system on a real document corpus and asked for structured feedback.

**Participants:** Daily staffers (n = ), including reporters and editors with experience analyzing and reporting off of FOIA responses.

**Feedback summary:**

*(to be filled in)*

**Specific failure modes or limitations raised:**

*(to be filled in)*

**What worked well:**

*(to be filled in)*

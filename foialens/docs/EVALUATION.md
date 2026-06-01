# FOIALens Evaluation

This is my evaluation methodology for FOIALens. I ran two main evaluations:

## 1. Recall on a Known-Story Corpus

**Method:** Select a FOIA release where the newsworthy angle is already publicly known.

I used the Epstein files for this example, specifically the existing news coverage in The Stanford Daily regarding [Stephen Kosslyn](https://stanforddaily.com/2026/02/05/sexual-assault-epstein-kosslyn/) and [Nathan Wolfe](https://stanforddaily.com/2026/02/03/former-stanford-professor-nathan-wolfe-92-planned-sexual-behavior-research-described-interns-with-epstein/). I ran FOIALens on the raw documents without any directed prompt (exploratory mode) and checked whether the system independently surfaced the known angle as a proposed story angle. This tests whether FOIALens finds things a journalist would actually pursue.

**Results:**

FOIALens successfully proposed the angle about Kosslyn and Wolfe's connections to Epstein, citing specific pages from the DOJ release where their names and interactions were mentioned.

**Observations:**

It also proposed some other angles that were less relevant or redundant, which is expected in exploratory mode. However, I was satisfied since the known angles were ranked highly and surfaced without any directed prompting.

---

## 2. User Feedback — The Stanford Daily

FOIALens was presented to staff members at The Daily, including reporters and editors with experience analyzing and investigating large document sets. Participants were shown a live demo of the system on a real document corpus and asked for structured feedback.

**What worked well:**

- "I liked the home page with the examples of angles and that shows how the system can be used."

- "A big concern of mine with using AI tools usually is that they might hallucinate or make things up, so it was good that the system always cited specific pages from the documents for easy fact-checking."

- "Proposed angles were interesting, accurate."

- "The website design is cool."

- "PDF viewer that opens to the cited page."

-  "Asking follow-up questions in the thread chat was actually a big improvement to when I usually use ChatGPT, since its answers are specific to the document I uploaded and it cites the exact page."

- "I ran some documents that I'd used in a previous investigation, and it actually raised some good points about things I should've followed up on but didn't."

**Limitations raised:**

- "I'm not sure when the entities/timelines view would be useful compared to just doing keyword search."

- "I would've appreciated an interactive tutorial on how to use the tool when I first sign up."

- "The site felt too slow at times, especially when loading documents or waiting for the full investigation to finish running."

- "Some of the proposed angles were duplicates"

- "I ran the investigation and it only showed one proposed angle, even though the documents were pretty extensive."

- "It would be cool to be able to give FOIALens a profile on myself, like what newspaper I work for an what stories I'm interested in writing, so the proposed angles are tailored to that."
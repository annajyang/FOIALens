# FoiaLens

An AI-powered document analysis tool for journalists. Upload FOIA-released PDFs, ask questions, and get answers with precise PDF citations.

**Live deployment:** [https://foialens-app-lzb2j.ondigitalocean.app/](https://foialens-app-lzb2j.ondigitalocean.app/)

---

## Demo File Sets

Try the tool with these real document sets included in this repo:

- **[Epstein Files](demo_files/epstein_files.zip)** — DOJ-released documents showing correspondence and connections between Jeffrey Epstein and Stanford affiliates Nathan Wolfe and Stephen Kosslyn.
- **[Palo Alto City Council](demo_files/palo_alto_city_council.zip)** — Large documents from a finance committee session and an architectural review board session.

In both cases, manually reading through the documents to surface key information would take a journalist hours. FoiaLens surfaces answers in seconds, with citations pointing back to the exact source pages.

---

## How to Use

1. **Create a workspace** — give it a name related to your investigation.
2. **Upload documents** — drag and drop or select PDFs from your file system.
3. **Ask questions** — type a question about the documents in the chat. The agent will search across all uploaded files and respond with inline citations.
4. **Follow citations** — click any citation badge (e.g. `[filename, p.4]`) to jump directly to that page in the PDF viewer.
5. **Explore angles** — the agent can propose investigative angles based on patterns it finds across documents.

---

## AI Declaration

This project was developed in collaboration with AI tools. Features were implemented with the assistance of [Claude Code](https://claude.ai/code), and the UI/UX design was created using [Claude](https://claude.ai).

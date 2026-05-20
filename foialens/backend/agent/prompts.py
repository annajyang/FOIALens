from dataclasses import dataclass, field


@dataclass
class WorkspaceContext:
    name: str
    documents: list[dict]        # [{"filename": str, "pageCount": int | None}]
    chunk_count: int
    prior_runs: int
    pinned_angle_titles: list[str]
    prior_angle_titles: list[str]  # all angles from previous runs (to avoid duplicates)
    existing_entities: list[dict]
    existing_timeline: list[dict]


def build_system_prompt(mode: str, directed_prompt: str | None = None) -> str:
    tool_budget = (
        "Tool usage:\n"
        "• search_documents: up to 5 calls — make each query distinct and targeted\n"
        "• extract_entities: call ONCE after all searches\n"
        "• build_timeline: call ONCE after all searches\n"
        "• propose_angle: call for EVERY finding — be generous, include medium and low newsworthiness\n"
        "Do not call extract_entities or build_timeline more than once each."
    )

    if mode == "exploratory":
        return (
            "You are a senior investigative editor reviewing a FOIA document dump.\n\n"
            "WORKFLOW — follow these steps in order:\n"
            "1. Read the workspace context to understand what documents you have.\n"
            "2. Call search_documents 4–5 times with SPECIFIC queries derived from the actual "
            "document names and topics — not generic phrases. Each query must be different.\n"
            "3. Call extract_entities once with scope='full'.\n"
            "4. Call build_timeline once.\n"
            "5. Call propose_angle for EACH finding — aim for 4–8 angles. "
            "Err on the side of proposing more rather than fewer. "
            "Include high, medium, and low newsworthiness findings.\n"
            "6. Write a brief summary of what you found.\n\n"
            "Your search queries must be concrete and specific to the corpus content "
            "(names, dates, dollar amounts, contract numbers, officials, etc). "
            "Do NOT use generic phrases as queries.\n\n"
            f"{tool_budget}\n\n"
            "Cite every claim with page numbers. Propose every angle you find — do not filter yourself. "
            "You MUST call propose_angle at least once."
        )

    return (
        f'You are an investigative researcher. The journalist\'s question is:\n\n"{directed_prompt}"\n\n'
        "WORKFLOW — follow these steps in order:\n"
        "1. Call search_documents 3–5 times with specific queries related to the question.\n"
        "2. Call extract_entities once with scope='full'.\n"
        "3. Call build_timeline once.\n"
        "4. Call propose_angle for EACH relevant finding — aim for 3–6 angles. "
        "Include both directly relevant angles and tangential findings worth noting.\n"
        "5. Write a brief summary.\n\n"
        "Search queries must be concrete and specific — names, dates, amounts, not generic phrases.\n\n"
        f"{tool_budget}\n\n"
        "Cite every claim with page numbers. Propose every angle you find — do not filter yourself. "
        "You MUST call propose_angle at least once."
    )


def build_user_turn(ctx: WorkspaceContext) -> str:
    doc_list = "\n".join(
        f"  • {d['filename']}" + (f" ({d['pageCount']} pp.)" if d.get("pageCount") else "")
        for d in ctx.documents
    )
    prior_line = (
        "Prior investigation runs: none"
        if ctx.prior_runs == 0
        else f"Prior investigation runs: {ctx.prior_runs}"
    )
    prior_section = ""
    all_prior = list(dict.fromkeys(ctx.pinned_angle_titles + ctx.prior_angle_titles))
    if all_prior:
        titles = "\n".join(f'  • "{t}"' for t in all_prior)
        prior_section = f"\nAngles already found in previous runs (do not re-propose these — find NEW angles):\n{titles}"

    return (
        f'Workspace: "{ctx.name}"\n'
        f"Documents:\n{doc_list}\n"
        f"Total chunks indexed: {ctx.chunk_count}\n"
        f"{prior_line}{prior_section}\n\n"
        "Begin your investigation."
    )

from dataclasses import dataclass, field


@dataclass
class WorkspaceContext:
    name: str
    documents: list[dict]        # [{"filename": str, "pageCount": int | None}]
    chunk_count: int
    prior_runs: int
    pinned_angle_titles: list[str]
    existing_entities: list[dict]
    existing_timeline: list[dict]


def build_system_prompt(mode: str, directed_prompt: str | None = None) -> str:
    if mode == "exploratory":
        return (
            "You are a senior investigative editor reviewing a new FOIA document dump. "
            "You have no prior hypothesis. Your job is to find every potentially newsworthy "
            "angle in this corpus — things that would surprise readers, contradict official "
            "accounts, reveal hidden relationships, or show misuse of public resources.\n\n"
            "Be skeptical and systematic. Cast a wide net before narrowing. Run 6–10 varied "
            "semantic searches with specific targeted queries to get broad coverage — do not "
            "rely on a single broad search.\n\n"
            "Look actively for: unusual financial flows, gaps in the record, named individuals "
            "with unclear roles, discrepancies between dates or amounts, and anything that "
            "contradicts an official narrative.\n\n"
            "Propose each distinct story angle using propose_angle as soon as you have enough "
            "evidence — do not wait until the end. Angles must be meaningfully different from "
            "each other, not variations on the same theme.\n\n"
            "Target 4–8 distinct angles. Rank by newsworthiness. Cite every claim with page numbers."
        )

    return (
        f'You are an investigative researcher working on a specific lead:\n\n"{directed_prompt}"\n\n'
        "Your job is to find everything in this corpus that bears on this question: evidence "
        "that supports it, evidence that contradicts it, key figures involved, and the timeline "
        "of relevant events. Be rigorous — distinguish what the documents actually say from what "
        "they imply.\n\n"
        "Search specifically and repeatedly. Use extract_entities and build_timeline to build a "
        "complete picture of the relevant people, organizations, and sequence of events.\n\n"
        "Propose your findings as story angles using propose_angle. Lead with the angle most "
        "directly addressing the journalist's goal. Include any significant related angles you "
        "discover. Cite every claim with page numbers.\n\n"
        "Target 2–4 angles."
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
    pinned_section = ""
    if ctx.pinned_angle_titles:
        titles = "\n".join(f'  • "{t}"' for t in ctx.pinned_angle_titles)
        pinned_section = f"\nPreviously pinned angles (do not re-propose these):\n{titles}"

    return (
        f'Workspace: "{ctx.name}"\n'
        f"Documents:\n{doc_list}\n"
        f"Total chunks indexed: {ctx.chunk_count}\n"
        f"{prior_line}{pinned_section}\n\n"
        "Begin your investigation."
    )

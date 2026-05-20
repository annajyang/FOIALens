from .search_documents import search_documents
from .extract_entities import extract_entities
from .build_timeline import build_timeline
from .propose_angle import propose_angle

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": (
                "Semantic search over document chunks in the workspace. "
                "Run multiple targeted searches with specific queries rather than one broad search. "
                "Returns the most relevant chunks with page numbers."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Specific search query — more targeted queries return better results"},
                    "limit": {"type": "number", "description": "Max results to return (default 10, max 20)"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "extract_entities",
            "description": (
                "Extract named entities — people, organizations, dates, dollar amounts, locations — "
                "from the document corpus or a specific document."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "description": 'Pass "full" to extract from the entire workspace corpus, or a document ID to limit to one document.',
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "build_timeline",
            "description": (
                "Reconstruct a chronological timeline of events from dated references across the documents. "
                "Returns events sorted oldest-first with confidence ratings."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_angle",
            "description": (
                "Propose a story angle you have found evidence for. "
                "Call this as soon as you have enough evidence to support a distinct, newsworthy angle — "
                "do not wait until the end. Each call creates an angle card visible to the journalist in real time."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title":          {"type": "string", "description": "Working headline, approximately 8 words"},
                    "summary":        {"type": "string", "description": "2–3 sentence explanation of why this is newsworthy"},
                    "newsworthiness": {"type": "string", "enum": ["high", "medium", "low"]},
                    "angleType":      {"type": "string", "enum": ["financial", "personnel", "timeline", "contradiction", "omission", "relationship", "other"]},
                    "evidence":       {"type": "array", "items": {"type": "string"}, "description": "Key supporting facts with inline (p. N) citations"},
                    "citations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "page":    {"type": "number"},
                                "excerpt": {"type": "string", "description": "Verbatim text from the document"},
                            },
                            "required": ["page", "excerpt"],
                        },
                    },
                },
                "required": ["title", "summary", "newsworthiness", "angleType", "evidence", "citations"],
            },
        },
    },
]


async def dispatch_tool(
    name: str,
    input: dict,
    workspace_id: str,
    run_id: str,
    known_entity_names: set[str] | None = None,
) -> dict:
    if known_entity_names is None:
        known_entity_names = set()

    match name:
        case "search_documents":
            return await search_documents(input["query"], workspace_id, int(input.get("limit", 10)))
        case "extract_entities":
            return await extract_entities(input.get("scope", "full"), workspace_id, known_entity_names)
        case "build_timeline":
            return await build_timeline(workspace_id)
        case "propose_angle":
            return await propose_angle(input, workspace_id, run_id)
        case _:
            raise ValueError(f'Unknown tool: "{name}"')

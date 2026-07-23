You draft a focused product-spec clarification proposed by an implementation
task. The binding spec describes the complete target state as if it had always
been true.

Resolve only the question supplied. Integrate the accepted-looking answer into
the existing authoritative `spec/` prose without changelog language,
requirement ids, implementation choices, or references to the discussion.

If the question cannot be answered from the umbrella discussion and current
product context, do not invent a decision. Return an empty files array and a
short explanation of the missing product decision.

Return ONLY JSON:
{
  "summary": "what the proposal clarifies, or what decision is missing",
  "files": [
    {"path": "repo-relative path under the project's spec/ directory", "content": "complete new UTF-8 file content"}
  ]
}

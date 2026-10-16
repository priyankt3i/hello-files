# Hello Files: Build-vs-Adopt Findings

**Prepared:** 15 October 2026
**Scope:** (1) What the Hello Files code actually does today, compared with its README and management deck. (2) Whether an existing open-source or commercial tool can replace it. (3) Recommendation and plan.

---

## 1. Executive summary

- **No existing tool does all of what Hello Files sets out to do.** We evaluated 13 alternatives (section 4).
  - Hello Files' intended combination is: a Windows desktop app with no Docker or server, indexing an entire folder tree, Office files plus OCR, credentials in the Windows keystore, and a choice of local or cloud AI models.
  - No evaluated product offers all of that. The closest, Msty, is closed source, has no documented Excel or OCR support, and stores enterprise user and audit data on the vendor's servers.
- **Hello Files is a working prototype, but not yet ready for a pilot.**
  - It indexes folders, answers questions with citations, and keeps API keys in the Windows Credential Manager.
  - Several claims in the README and in the management deck are not true of the current code (section 3).
- **The most important correction concerns data protection.** The deck says files "never leave local disks" and that "LLM calls send only text queries".
  - In reality, excerpts of documents (up to about 12,000 characters per question), document summaries and up to 3 page images are sent to whichever AI provider is configured.
  - Data stays entirely on the laptop **only** when a local model (Ollama) is used.
- **Recommendation:** finish Hello Files, with a first milestone of a locked-down, local-models-only pilot. Reuse proven designs from open-source projects rather than writing everything from scratch. Estimated pilot-readiness work is listed in section 6.

---

## 2. What Hello Files is

A desktop application for Windows. A user selects a folder, the app reads every file under it, and the user can then chat with an AI assistant about the contents, with answers citing the source files.

| Component | Technology |
|---|---|
| Desktop shell and UI | Electron + React |
| App data (channels, chats) | SQLite in the user's app-data folder |
| File reading and search index | Python worker (PyMuPDF, python-docx, openpyxl, RapidOCR) |
| Secrets | Windows Credential Manager (via `keytar`) |
| AI providers | OpenAI, Azure OpenAI, Anthropic, Google Gemini, Ollama (local), OpenAI Codex |

---

## 3. Code audit: claims vs reality

The audit read the full source (about 10,000 lines). The findings below come from the code itself, not from the documentation.

### 3.1 What works as described
- Creating "channels" from local folders and chatting against them with source citations (file path, matched text, spreadsheet sheet and row).
- Reading PDF, Word (.docx, and .doc on a best-effort basis), Excel (.xlsx, .xls), images with OCR, and 50+ text, code and config formats.
- Two search modes:
  - "Vector" mode, which uses AI embeddings.
  - "Vectorless" mode, which uses keyword search and has the AI pick documents from a list.
- API keys for OpenAI, Anthropic, Gemini and Azure stored in the Windows Credential Manager. The app database holds only a reference to each key.
- Indexed and failed files are listed in the UI with failure reasons.
- Reasonable desktop security settings: renderer isolation, a strict content policy, and opened files restricted to the selected folder.

### 3.2 Where the deck or README is inaccurate

| Claim | Reality |
|---|---|
| "Files never leave local disks" / "LLM calls send only text queries" | **Inaccurate.** Each question sends the AI provider up to 8 document excerpts (≤1,500 characters each), the last 6 chat messages, up to 3 images, and (in vectorless mode) a list of up to 24 document summaries. Vector mode also sends **all document text** to the embedding provider during indexing. Only Ollama keeps everything local. |
| "100% offline retrieval" in vectorless mode | The search step is offline. Answering, and choosing documents in vectorless mode, both call the chat model, so the process is offline end to end only with Ollama. |
| "Keys in the OS secure vault" | True for API keys. **Not true for the OpenAI Codex sign-in**, whose tokens are stored in a plain-text file in the user's profile. |
| "Smart rebuilds", only changed files are re-processed | **Not effective today.** "Start indexing" on an existing index skips the scan entirely. "Regenerate" re-processes every file. New or edited files are picked up only through a full rebuild. |
| Azure OpenAI supported | **Not usable.** The UI has no fields for the Azure endpoint or deployment name. |
| "~95% overall readiness" | No automated tests, no code signing, no installer suitable for IT deployment, and CI is likely broken (a missing lockfile). "Functional prototype" is the more accurate description. |
| Index stored safely beside the folder | A hidden `.fschat-index` folder is written **inside the user's folder**. It contains an **unencrypted plain-text copy** of all extracted content. If the folder is on OneDrive, SharePoint or a network share, that copy syncs too, and it does not inherit sensitivity labels, retention or legal-hold controls. |

### 3.3 Compliance concern: the OpenAI Codex provider
The Codex sign-in option:
- reuses OpenAI's own Codex client identity;
- calls a private ChatGPT endpoint;
- identifies itself to OpenAI as a different third-party product (`originator: "cline"`).

It also routes company content through employees' **personal ChatGPT accounts**, which are outside any enterprise data agreement. **We recommend removing it before any security review.**

### 3.4 Other defects found
- Indexing includes `.git` and `node_modules` folders and follows shortcut links outside the chosen folder. There is no file-size limit.
- A cancel request sent while idle silently cancels the next indexing run.
- A file deleted during indexing aborts the whole run.
- Cancelling with "keep partial" replaces a previous complete index with the partial one.
- AI embedding calls have no timeout, so a stalled provider can hang indexing indefinitely.
- Spreadsheet questions like "how many rows where X" ignore the filter and return the total row count.
- A failed AI call leaves an unanswered question in the chat history.
- Image support for AI models is guessed from the model's name.

The full technical list, with file references, is in `CLAUDE.md` at the repository root.

---

## 4. Alternatives evaluated

### 4.1 Criteria
Each candidate was scored against what Hello Files is meant to do, plus the basics an enterprise deployment needs:

1. Index an entire folder tree automatically.
2. Automatically pick up new, changed and deleted files.
3. Office documents plus OCR for scans and images.
4. Citations back to the source.
5. Fully offline with local models.
6. Support for OpenAI, Azure OpenAI, Anthropic and Gemini.
7. Credentials stored in the OS keystore.
8. Native Windows desktop app with no Docker and no open network ports.
9. Sending document images to vision-capable models.
10. Spreadsheet-aware answers.
11. License and project health.

### 4.2 Comparison

Key: **Y** = yes, **P** = partial, **N** = no, **?** = not documented. The Hello Files column reflects the code today.

| Criterion | Hello Files | Msty Studio | AnythingLLM Desktop | Open WebUI | GPT4All | Cherry Studio | Khoj | Kotaemon | RAGFlow |
|---|---|---|---|---|---|---|---|---|---|
| Indexes whole folder tree | **Y** | P | **N** | P (add-on CLI) | Y | Y (folders can be added) | Y | N | N |
| Auto-picks up changes | **N** (bug) | Y | P | P (add-on) | Y | ? | P (10-min poll) | N | P (cloud sources only) |
| Office files + OCR | Y (no PPTX) | P | P (no .doc/.xls) | P (needs extra server) | N | Y | P | Y | Y |
| Citations | P | P | P | Y | P | Y | P | Y | Y |
| Fully offline (local models) | Y | Y | Y (telemetry on by default) | Y | Y | Y | P (telemetry on) | P | P |
| OpenAI / Azure / Anthropic / Gemini | P (Azure broken) | Y (Azure on paid tier) | Y | P | P | P | P | Y | Y |
| Keys in OS keystore | **Y** | P (experimental) | N (plain-text file) | N | N (plain text) | ? | N | N | ? |
| Desktop, no Docker, no open ports | **Y** | Y | P (local server) | N (listens on network by default) | Y | Y | P | P (browser app) | N (Docker, multiple services) |
| Images to vision models | Y | P | P | P | N | ? | P | Y | Y |
| Spreadsheet-aware | P | ? | P | P | N | ? | N | P | P |
| License | Internal | Proprietary, paid | MIT | Custom (branding limits) | MIT | AGPL-3.0 | AGPL-3.0 | Apache-2.0 | Apache-2.0 |
| Health (Oct 2026) | — | Active | Very active | Very active | **Inactive since 2025** | Very active | Slowing | Stalled since May 2026 | Very active |

### 4.3 Notes per candidate
- **Msty Studio:** the closest feature match, with folder sync, all major providers and an enterprise tier with Entra ID SSO.
  - It is closed source and requires a commercial license.
  - Excel and OCR support are not documented.
  - Enterprise mode stores user, team and audit data on Msty's servers, which needs a vendor-risk review.
- **AnythingLLM Desktop:** popular and MIT-licensed, but it cannot index a folder tree.
  - Its maintainers confirm folder indexing isn't supported.
  - It stores API keys in a plain-text file and has telemetry on by default.
- **Open WebUI:** strong knowledge-base and enterprise features, but it is a server, not a desktop app.
  - It listens on all network interfaces by default.
  - Its desktop app is alpha.
  - Its license restricts removing its branding above 50 users.
- **GPT4All:** has the right indexing design (recursive, watches for changes, incremental), but it can't read Excel, PowerPoint or .doc, has no OCR, and has had no release since February 2025.
- **Cherry Studio:** the strongest open-source desktop candidate. Folder knowledge bases, OCR and citations are documented.
  - Automatic re-sync, Azure support and local OCR on Windows are unconfirmed.
  - AGPL licensing and vendor origin need legal and security review.
- **Khoj:** folder sync, but no OCR for scanned PDFs, no Office formats beyond Word, and no page-level citations. The vendor is winding down its cloud product.
- **Kotaemon:** excellent document parsing and citations, but no folder indexing or sync, and development has stalled.
- **RAGFlow:** the most capable engine and very actively developed, but it requires Docker and several back-end services and has no local-folder source. It is suitable only as a centrally hosted IT service pointed at SharePoint or OneDrive.
- **Also reviewed and ruled out:**
  - Jan and LM Studio: no folder knowledge base.
  - PyGPT: citations and OCR unclear.
  - PrivateGPT: a server, not a desktop app.
  - Reor, h2oGPT and NVIDIA ChatRTX: archived or deprecated in 2026.
  - Onyx: requires Docker.
  - Windows Copilot file search: finds files but does not answer questions about them, and is limited to Copilot+ PCs.

### 4.4 Also worth considering
If most of the target documents already live in **OneDrive or SharePoint**, **Microsoft 365 Copilot** (already licensed in our environment) or a centrally hosted platform may solve the problem without any per-laptop software. Hello Files is justified mainly for content that is **genuinely local-only**.

---

## 5. Recommendation

**Finish Hello Files, scoped to a secure local-first pilot, and reuse proven open-source designs where licenses allow:**

| Borrow from | What | License |
|---|---|---|
| GPT4All | File-watcher plus incremental re-indexing design | MIT |
| Kotaemon | Docling / PaddleOCR document loaders; citation viewer with highlights | Apache-2.0 |
| Khoj | Change detection by file modification time | AGPL-3.0 (design idea only, no code reuse) |

**Correct the management deck** before it is presented again, specifically the data-flow and readiness statements in section 3.2.

---

## 6. Plan to pilot readiness

| # | Work item | Why |
|---|---|---|
| 1 | Remove the Codex provider. Add an admin "approved endpoints only / local-only" lock. Correct the deck. | Makes the data-protection claim true and removes the compliance risk |
| 2 | Make incremental indexing work and add automatic change detection | Core usability; avoids full re-indexing |
| 3 | Make indexing safe on large folders: exclusions (`.git`, `node_modules`, hidden files), no following links outside the folder, file-size caps, timeouts | Reliability on real-world folders |
| 4 | Fix the correctness defects in section 3.4 | Trustworthy answers and indexing |
| 5 | Decide where the index lives: inside the folder (today) or in the app-data folder, optionally encrypted | Prevents plain-text copies syncing to cloud storage |
| 6 | Fix Azure OpenAI configuration; allow embeddings from a different provider | Azure is the likely enterprise endpoint |
| 7 | Automated tests for indexing and retrieval; fix CI | Prevents regressions |
| 8 | Code signing and a silent/MSI installer | Required for IT deployment |

Items 1–5 are the minimum for a controlled pilot. Items 6–8 are needed before a wider rollout.

---

## 7. Decisions requested
1. Approve completing Hello Files (sections 5–6) rather than adopting an existing tool.
2. Confirm the pilot's AI endpoint policy: local only (Ollama), or a company-approved Azure OpenAI endpoint.
3. Confirm the target content: local-only files, or also OneDrive/SharePoint (in which case Microsoft 365 Copilot should be compared first).
4. Name the pilot group and a security reviewer.

---

## Appendix: sources (accessed 15 Oct 2026)

- AnythingLLM: [folder indexing issue #3640](https://github.com/Mintplex-Labs/anything-llm/issues/3640), [Live Document Sync](https://docs.anythingllm.com/beta-preview/active-features/live-document-sync), [supported types](https://github.com/Mintplex-Labs/anything-llm/blob/master/collector/utils/constants.js), [credential storage](https://github.com/Mintplex-Labs/anything-llm/blob/master/server/utils/helpers/updateENV.js), [desktop overview](https://docs.anythingllm.com/installation-desktop/overview), [releases](https://github.com/Mintplex-Labs/anything-llm/releases), [community folder sync](https://github.com/dastra/anythingllm-document-sync)
- Open WebUI: [knowledge-base sync](https://docs.openwebui.com/ecosystem/knowledge-base-sync), [Docling extraction](https://docs.openwebui.com/features/chat-conversations/rag/document-extraction/docling), [license](https://docs.openwebui.com/license), [default bind address](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/__init__.py)
- GPT4All: [LocalDocs indexing source](https://raw.githubusercontent.com/nomic-ai/gpt4all/main/gpt4all-chat/src/database.cpp), [settings](https://raw.githubusercontent.com/nomic-ai/gpt4all/main/gpt4all-chat/src/mysettings.cpp), [LocalDocs docs](https://docs.gpt4all.io/gpt4all_desktop/localdocs.html), [commit history](https://github.com/nomic-ai/gpt4all/commits/main)
- Msty: [Knowledge Stacks Next Gen](https://docs.msty.ai/studio/knowledge-stacks/next-gen), [online providers](https://docs.msty.ai/studio/managing-models/online-providers), [encryption](https://docs.msty.ai/studio/workspaces/lock-and-encryption), [pricing](https://msty.ai/pricing), [enterprise](https://docs.msty.ai/studio/enterprise/overview), [changelog](https://msty.ai/changelog)
- Cherry Studio: [repository](https://github.com/CherryHQ/cherry-studio), [knowledge base](https://docs.cherry-ai.com/docs/en-us/knowledge-base/knowledge-base), [document preprocessing](https://docs.cherry-ai.com/en-us/knowledge-base/document-preprocessing)
- Khoj: [desktop folder sync source](https://raw.githubusercontent.com/khoj-ai/khoj/master/src/interface/desktop/main.js), [telemetry](https://docs.khoj.dev/miscellaneous/telemetry), [releases](https://github.com/khoj-ai/khoj/releases)
- Kotaemon: [repository](https://github.com/Cinnamon/kotaemon), [upload UI source](https://raw.githubusercontent.com/Cinnamon/kotaemon/main/libs/ktem/ktem/index/file/ui.py)
- RAGFlow: [repository](https://github.com/infiniflow/ragflow), [data sources](https://ragflow.io/docs/add_data_source/data_source_configuration), [releases](https://github.com/infiniflow/ragflow/releases)
- Others: [PyGPT](https://github.com/szczyglis-dev/py-gpt), [PrivateGPT](https://github.com/zylon-ai/private-gpt/releases), [Jan](https://jan.ai/docs/tools/retrieval), [LM Studio](https://lmstudio.ai/docs/app/basics/rag), [Reor (archived)](https://github.com/reorproject/reor), [h2oGPT (archived)](https://github.com/h2oai/h2ogpt), [Onyx desktop](https://docs.onyx.app/deployment/local/desktop_app)

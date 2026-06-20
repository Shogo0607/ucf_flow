import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();
const htmlPath = path.join(root, "src", "フロー化ツール（A・パイプライン）.dc.html");
const html = fs.readFileSync(htmlPath, "utf8");
const script = (html.match(/<script\b[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/) || [])[1];
assert.ok(script, "script block should exist");

globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.DCLogic = class {
  constructor() { this.props = {}; }
  setState(patch) { this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) }; }
};

vm.runInThisContext(script.replace("class Component extends DCLogic", "globalThis.Component = class Component extends DCLogic"), { filename: htmlPath });

const c = new globalThis.Component();
c.state.db = {
  folders: [
    { id: "f_sales", name: "営業", parent: "" },
    { id: "f_quote", name: "見積", parent: "f_sales" },
    { id: "f_support", name: "サポート", parent: "" },
  ],
  docs: [],
};
c.state.savedFlows = [
  {
    id: "flow_quote",
    wsId: "ws_default",
    title: "見積承認フロー",
    folderId: "f_quote",
    sourceFolderPath: "営業 / 見積",
    flow: {
      title: "見積承認フロー",
      root: "n1",
      sourceFolderId: "f_quote",
      sourceFolderPath: "営業 / 見積",
      nodes: {
        n1: { kind: "decision", text: "値引き率は承認範囲内か？", why: "見積承認の要否を分ける", yes: "n2", no: "n3" },
        n2: { kind: "result", text: "営業担当で見積提出する" },
        n3: { kind: "result", text: "部長承認を取得する" },
      },
    },
  },
  {
    id: "flow_support",
    wsId: "ws_default",
    title: "障害一次切り分け",
    folderId: "f_support",
    sourceFolderPath: "サポート",
    flow: {
      title: "障害一次切り分け",
      root: "n1",
      sourceFolderId: "f_support",
      sourceFolderPath: "サポート",
      nodes: {
        n1: { kind: "decision", text: "全端末で接続できないか？", yes: "n2", no: "n3" },
        n2: { kind: "result", text: "ネットワーク機器を確認する" },
        n3: { kind: "result", text: "端末側を確認する" },
      },
    },
  },
];
c.state.kbSources = [
  {
    id: "kb_quote",
    name: "特約店見積ルール.pdf",
    folderId: "f_quote",
    pages: [
      { page: 1, summary: "見積依頼は特約店へ引き継ぎ、営業は直接価格回答しない。", keywords: ["見積", "特約店"], md: "見積依頼は担当特約店へ引き継ぐ。営業担当は価格を直接回答しない。" },
    ],
  },
];

const cands = c.candidateFlows();
assert.equal(cands.length, 2, "candidateFlows should include saved flows");
assert.ok(c.flowFolderTreeText(cands).includes("営業 / 見積"), "flow hierarchy should expose folder paths");

const intent = c.flowNormalizeSearchIntent({
  question_rewrite: "見積の承認手順",
  folder_hints: ["営業 / 見積"],
  flow_hints: ["見積承認"],
  query_variants: ["見積 承認", "値引き 部長承認"],
}, "見積の承認はどう進める？");
const hits = c.flowSearchWithIntent(intent, cands);
assert.equal(hits[0].flow.id, "flow_quote", "folder_hints and flow_hints should prioritize the matching flow");
assert.notEqual(hits.findIndex(h => h.flow.id === "flow_support"), 0, "unrelated flow should not outrank the matching flow");

const quoteFlowRec = cands.find(f => f.id === "flow_quote");
const routeResult = {
  answer: "営業として見積依頼を受けた場合は、価格をDBから直接回答せず、担当特約店に繋いで見積作成を依頼します。",
  path: ["n1", "n3"],
  flowId: "flow_quote",
  flowTitle: "見積承認フロー",
  flowPath: "営業 / 見積",
};
routeResult.harness = c.buildFlowHarnessContext("見積もりを依頼したい", quoteFlowRec, routeResult);
assert.equal(routeResult.harness.signal, "route", "flow harness should detect business routing / handoff");
assert.equal(c.flowHarnessShouldSkipDb("見積もりを依頼したい", routeResult), true, "handoff-style flow result should allow skipping DB");
assert.equal(c.flowHarnessShouldSkipDb("見積もり価格の根拠資料を教えて", routeResult), false, "evidence-seeking questions should still use DB");
const dbQWithFlow = c.composeDbQuestionWithFlowContext("見積もり価格の根拠資料を教えて", routeResult.harness);
assert.ok(dbQWithFlow.includes("フロー観測"), "DB question should carry flow observations when DB is needed");
assert.ok(dbQWithFlow.includes("特約店"), "flow path context should be available to DB search as context");

const curationRaw = {
  source_interpretation: {
    kind: "業務ルーティング",
    summary: "見積依頼時の特約店引き継ぎルール",
    new_flow_needed: false,
    anti_proliferation_check: ["既存の見積承認フローに吸収できる"],
  },
  proposals: [
    {
      decision: "attach_evidence",
      flowId: "flow_quote",
      nodeId: "n3",
      refs: ["src:kb_quote:1"],
      confidence: 0.9,
      reason: "特約店へ引き継ぐ結論ノードの根拠資料として扱えるため、新規フロー化は不要。",
    },
    {
      decision: "add_condition",
      flowId: "flow_quote",
      nodeId: "n3",
      models: ["特約店経由"],
      detail: "見積依頼が特約店経由の場合は、営業が価格を直接回答せず担当特約店へ引き継ぐ。",
      confidence: 0.86,
      reason: "既存の部長承認側ノードに条件として追加できる。",
    },
    {
      decision: "create_new",
      detail: "新規業務ではないため本来は不要な候補",
      confidence: 0.2,
      reason: "低信頼の新規候補はレビュー扱い。",
    },
  ],
};
const curationItems = c.normalizeCurationProposals(curationRaw, c.flowsForProposal(), c.state.kbSources[0]);
assert.equal(curationItems.length, 3, "curation proposals should normalize supported decisions");
assert.equal(curationItems[0].op, "attach_evidence", "evidence proposal should be preserved");
assert.equal(curationItems[1].op, "add_condition", "condition proposal should be preserved");
assert.equal(curationItems[2].op, "create_new", "new flow proposal should remain review-only");
c._applyProposalToFlow(curationItems[0]);
let savedQuote = c.state.savedFlows.find(f => f.id === "flow_quote");
assert.ok((savedQuote.flow.nodes.n3.links || []).some(l => l.url === "kb:src:kb_quote:1"), "approving attach_evidence should add a kb link to the node");
c._applyProposalToFlow(curationItems[1]);
savedQuote = c.state.savedFlows.find(f => f.id === "flow_quote");
assert.ok((savedQuote.flow.nodes.n3.models || []).includes("特約店経由"), "approving add_condition should add condition tags");
assert.ok((savedQuote.flow.nodes.n3.detail || "").includes("担当特約店"), "approving add_condition should append condition detail");
c.state.flowLibCurrent = "flow_quote";
const flowLibVals = c.flowLibraryVals(c.state);
assert.equal(flowLibVals.flowLibCount, 2, "flow library should list all saved flows in the workspace");
assert.equal(flowLibVals.flowLibTitle, "見積承認フロー", "flow library should expose the selected flow title");
assert.ok(flowLibVals.flowLibNodes.some(n => n.id === "n3" && n.hasLinks), "flow library should expose node-level DB links");
assert.ok(flowLibVals.flowLibDbRefs.some(r => r.ref === "src:kb_quote:1"), "flow library should expose DB references across the selected flow");

const extractPrompt = c.buildPrompt("価格表を見て、特約店経由なら営業は直接回答せず引き継ぐ。価格はDBの価格表を参照する。");
assert.ok(extractPrompt.includes("フロー/DBの切り分け基準"), "flow extraction prompt should include flow-vs-db criteria");
assert.ok(extractPrompt.includes("条件によって『行動』が変わる場合だけフロー分岐"), "flow extraction should branch on action-changing conditions");
assert.ok(extractPrompt.includes("db_query"), "flow extraction schema should allow DB lookup nodes");

const flowWithDbRefs = {
  title: "DB参照テスト",
  root: "n1",
  nodes: {
    n1: { kind: "decision", text: "特約店経由か？", yes: "n2", no: "n3", db_query: "特約店条件を確認" },
    n2: { kind: "action", text: "DBで価格根拠を確認", db_refs: ["src:kb_quote:1"], next: "n4" },
    n3: { kind: "result", text: "通常見積へ進む" },
    n4: { kind: "result", text: "特約店へ引き継ぐ" },
  },
};
const normalizedDbFlow = c.normalizeFlowDbReferences(flowWithDbRefs, { docRefs: ["doc:d_history"], nodeIds: ["n1"] });
assert.ok((normalizedDbFlow.nodes.n1.links || []).some(l => l.url === "kb:doc:d_history"), "selected generated nodes should link to source DB history");
assert.ok(!(normalizedDbFlow.nodes.n3.links || []).some(l => l.url === "kb:doc:d_history"), "nodeIds option should avoid linking unrelated nodes");
assert.ok((normalizedDbFlow.nodes.n2.links || []).some(l => l.url === "kb:src:kb_quote:1"), "db_refs should normalize into kb links");
const dbHarness = c.buildFlowHarnessContext("価格根拠も確認して", { id: "flow_db", title: "DB参照テスト", flow: normalizedDbFlow }, { answer: "DB確認後に判断する", path: ["n1", "n2"], flowId: "flow_db", flowTitle: "DB参照テスト" });
assert.ok(dbHarness.searchContext.includes("DB確認:特約店条件を確認"), "db_query should be included in flow harness search context");

const prompt = c.buildChatHarnessPrompt("見積の承認はどう進める？", cands, [], [], false, "conditional", intent, hits);
assert.ok(prompt.includes("# フロー階層"), "harness prompt should include flow hierarchy");
assert.ok(prompt.includes("# フロー探索意図"), "harness prompt should include flow search intent");
assert.ok(prompt.includes("path:営業 / 見積"), "harness prompt should show candidate flow folder path");
assert.ok(prompt.includes("flow_quote"), "prioritized flow should be listed as a candidate");

const answerMarkdown = [
  "UX2の納入品は、まず機種がUX2-S型かどうかで確認範囲が分かれます。",
  "",
  "- **UX2-S型の場合**",
  "  1. まず **UX2-S型の添付品** を確認します。",
  "  2. 次に **共通の納入品** を確認します。",
  "",
  "- **UX2-S型でない場合**",
  "  1. **共通の納入品** を確認します。",
].join("\n");
const answerHtml = c.markdownToHtml(answerMarkdown);
assert.ok(answerHtml.includes("<strong>UX2-S型の場合</strong>"), "markdown renderer should render bold text");
assert.ok(answerHtml.includes("<ul>") && answerHtml.includes("<ol>"), "markdown renderer should render unordered and ordered lists");
assert.ok(!answerHtml.includes("**UX2-S型の場合**"), "markdown markers should not remain visible");
const detailMarkdown = [
  "UX2の納入品は、原典では以下のとおりです。",
  "",
  "- **共通納入品（UX2-D型, UX2-S型共通）**",
  "  1. IJプリンタ本体 1",
  "     - **UX2-S型の場合**：はじめから洗浄ユニットが取り付けられています。",
  "  2. 基本操作説明書 1",
  "",
  "- **添付品（UX2-S型のみに添付）**",
  "  1. 洗浄ユニット取付治具 2",
  "  2. 洗浄ユニットストッパ 4",
].join("\n");
c.state.chat = [{ role: "assistant", answer: answerMarkdown, detail: detailMarkdown }];
c.state.copiedChatIdx = 0;
const msgVals = c.chatMessageVals(c.state.chat[0], 0, c.state);
assert.equal(msgVals.answer, answerMarkdown, "chat view should keep markdown source for copying");
assert.ok(msgVals.answerHtml.__html.includes("<strong>UX2-S型の場合</strong>"), "chat view should expose rendered markdown html");
assert.ok(msgVals.detailHtml.__html.includes("<strong>共通納入品（UX2-D型, UX2-S型共通）</strong>"), "detail view should expose rendered markdown html");
assert.ok(msgVals.detailHtml.__html.includes("<ol>") && msgVals.detailHtml.__html.includes("<ul>"), "detail view should render nested lists");
assert.ok(!msgVals.detailHtml.__html.includes("**共通納入品"), "detail markdown markers should not remain visible");
assert.equal(msgVals.copied, true, "chat view should expose copied state");

const sessionPatch = c.chatSessionPatch({
  ...c.state,
  curWs: "ws_default",
  chatSessions: [],
  currentChatSessionId: "ch_test",
}, [
  { role: "user", text: "UX2の納入品を教えて" },
  { role: "assistant", answer: answerMarkdown, detail: detailMarkdown },
]);
assert.equal(sessionPatch.chatSessions.length, 1, "chat session sync should create a history item");
assert.equal(sessionPatch.chatSessions[0].title, "UX2の納入品を教えて", "chat session title should come from first user message");
assert.equal(sessionPatch.chatSessions[0].messages.length, 2, "chat session should keep messages for resume");
const nav = c.chatSessionNavVals({ ...c.state, chatSessions: sessionPatch.chatSessions, currentChatSessionId: "ch_test" });
assert.equal(nav.length, 1, "chat session nav should render history rows");
assert.equal(nav[0].id, "ch_test", "chat session nav should preserve session id");
c.state.chatSessions = sessionPatch.chatSessions;
c.state.chat = [];
c.loadChatSession({ currentTarget: { dataset: { id: "ch_test" } } });
assert.equal(c.state.currentChatSessionId, "ch_test", "clicking history should activate the session");
assert.equal(c.state.chat.length, 2, "clicking history should restore messages for resume");

console.log("flow search verification passed");

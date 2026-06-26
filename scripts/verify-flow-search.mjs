import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();
const htmlPath = path.join(root, "src", "フロー化ツール（A・パイプライン）.dc.html");
const helperPath = path.join(root, "src", "app-helpers.js");
const inquiryAnswerCsvPath = path.join(root, "test", "fixtures", "inquiry-answer-sample.csv");
const html = fs.readFileSync(htmlPath, "utf8");
const helperScript = fs.readFileSync(helperPath, "utf8");
const inquiryAnswerCsv = fs.readFileSync(inquiryAnswerCsvPath, "utf8");
const script = (html.match(/<script\b[^>]*data-dc-script[^>]*>([\s\S]*?)<\/script>/) || [])[1];
assert.ok(script, "script block should exist");

globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
vm.runInThisContext(helperScript, { filename: helperPath });
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
      sourceIds: ["kb_quote"],
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

assert.ok(html.includes("推奨列: 日付 / 問い合わせ・症状 / 確認したこと / 判断・対応 / 結果"), "CSV upload UI should describe the expected record shape");
assert.ok(html.includes("接続テスト"), "API settings should expose a connection test action");
c.ingestCsv("質問,回答,対応\n見積はどこに依頼する？,特約店へ引き継ぐ,担当特約店を案内\n", "qa.csv");
assert.equal(c.state.inputMode, "csv", "valid CSV should switch to CSV input mode");
assert.deepEqual(c.state.csvRows, ["質問：見積はどこに依頼する？ ｜ 回答：特約店へ引き継ぐ ｜ 対応：担当特約店を案内"], "CSV rows should be converted into labeled history records");
c.ingestCsv("問い合わせ内容,回答内容\n見積はどこに依頼する？,担当特約店へ引き継ぎます。\n", "inquiry-answer.csv");
assert.deepEqual(c.state.csvRows, ["問い合わせ内容：見積はどこに依頼する？ ｜ 回答内容：担当特約店へ引き継ぎます。"], "CSV should accept inquiry/answer headers");
c.ingestCsv("問い合わせ内容\t回答内容\n見積はどこに依頼する？\t担当特約店へ引き継ぎます。\n", "inquiry-answer.tsv");
assert.deepEqual(c.state.csvRows, ["問い合わせ内容：見積はどこに依頼する？ ｜ 回答内容：担当特約店へ引き継ぎます。"], "CSV import should tolerate tab-delimited exports");
c.ingestCsv("問い合わせ内容、回答内容\n見積はどこに依頼する？、担当特約店へ引き継ぎます。\n", "inquiry-answer-jpcomma.csv");
assert.deepEqual(c.state.csvRows, ["問い合わせ内容：見積はどこに依頼する？ ｜ 回答内容：担当特約店へ引き継ぎます。"], "CSV import should tolerate Japanese comma delimiters");
const sjisBytes = new Uint8Array([150,226,141,135,130,185,147,224,151,101,44,137,241,147,154,147,224,151,101,10,140,169,144,207,130,205,130,199,130,177,130,201,136,203,151,138,130,183,130,233,129,72,44,146,83,147,150,147,193,150,241,147,88,130,214,136,248,130,171,140,112,130,172,130,220,130,183,129,66,10]);
c.ingestCsv(sjisBytes.buffer, "sjis.csv");
assert.equal(c.state.csvName, "sjis.csv", "Shift_JIS CSV import should update the current CSV name");
assert.deepEqual(c.state.csvRows, ["問合せ内容：見積はどこに依頼する？ ｜ 回答内容：担当特約店へ引き継ぎます。"], "CSV import should decode Shift_JIS exports");
c.ingestCsv("質問,回答,対応\n", "empty.csv");
assert.ok(c.state.error.includes("ヘッダー行＋データ行"), "CSV with only a header row should show the required shape");
assert.equal(c.state.csvRows.length, 0, "failed CSV import should not leave previous rows visible");
c.ingestCsv(inquiryAnswerCsv, "inquiry-answer-sample.csv");
assert.equal(c.state.csvRows.length, 4, "sample inquiry/answer CSV should load four records");
c.sleep = async () => {};
c.hasLLM = () => true;
c.llmComplete = async () => "AI failed to return JSON";
const seededSavedFlows = c.state.savedFlows;
await c.analyzeCsv();
assert.equal(c.state.stage, "flow", "sample inquiry/answer CSV should generate a flow even when LLM JSON parsing fails");
assert.equal(c.state.flow.root, "n1", "generated CSV flow should have a root node");
assert.ok(Object.keys(c.state.flow.nodes).length >= 5, "generated CSV flow should include choice and answer nodes");
assert.ok(c.state.flow.nodes.n1.branches.some(b => b.label.includes("見積")), "generated CSV flow should expose inquiry choices");
assert.ok(Object.values(c.state.flow.nodes).some(n => String(n.text || "").includes("担当特約店")), "generated CSV flow should include answer content");
c.setState({ stage: "home", flow: null, savedFlows: seededSavedFlows, csvRows: [], csvRecords: [], csvName: "", curFlowId: null });

const persistedWrites = [];
const originalSetItem = globalThis.localStorage.setItem;
globalThis.localStorage.setItem = (key, value) => { persistedWrites.push([key, value]); };
c.persistKbSources([{ id: "kb_safe", folderId: "f_quote", pages: [] }]);
globalThis.localStorage.setItem = originalSetItem;
const kbWrite = persistedWrites.find(([key]) => key === "tpf_kbsrc_ws_default");
assert.ok(kbWrite, "persistKbSources should use the current workspace-scoped KB key even with duplicate helper definitions");
assert.deepEqual(JSON.parse(kbWrite[1]), [{ id: "kb_safe", folderId: "f_quote", pages: [] }], "persistKbSources should serialize the provided KB source array");
globalThis.localStorage.setItem = () => { throw new Error("quota exceeded"); };
c.persistDb({ folders: [], docs: [] });
globalThis.localStorage.setItem = originalSetItem;
assert.ok(c.state.storageWarning.includes("ナレッジDBを保存できませんでした"), "localStorage write failures should surface in component state");
c.clearStorageWarning();
assert.equal(c.state.storageWarning, null, "storage warning should be dismissible");

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
const curationItemsAfterApply = c.normalizeCurationProposals(curationRaw, c.flowsForProposal(), c.state.kbSources[0]);
assert.equal(curationItemsAfterApply.some(it => it.op === "attach_evidence"), false, "already linked evidence should not be proposed again");
assert.equal(curationItemsAfterApply.some(it => it.op === "add_condition"), false, "already applied conditions should not be proposed again");
c.state.savedFlows = c.state.savedFlows.map(f => f.id === "flow_quote" ? { ...f, flow: { ...f.flow, sourceIds: ["kb_quote"] }, sourceIds: ["kb_quote"] } : f);
let duplicateProposalCalledLlm = false;
c.hasLLM = () => true;
c.llmComplete = async () => { duplicateProposalCalledLlm = true; return "{}"; };
await c.runProposals("kb_quote");
assert.equal(duplicateProposalCalledLlm, false, "proposal generation should not call LLM when the same source already generated a flow");
assert.equal(c.state.proposals.alreadyFlowed, true, "already-flowed PDF should show a duplicate-suppression proposal state");
c.state.flowLibCurrent = "flow_quote";
const flowLibVals = c.flowLibraryVals(c.state);
assert.equal(flowLibVals.flowLibCount, 2, "flow library should list all saved flows in the workspace");
assert.equal(flowLibVals.flowLibTitle, "見積承認フロー", "flow library should expose the selected flow title");
assert.ok(flowLibVals.flowLibNodes.some(n => n.id === "n3" && n.hasLinks), "flow library should expose node-level DB links");
assert.ok(flowLibVals.flowLibDbRefs.some(r => r.ref === "src:kb_quote:1"), "flow library should expose DB references across the selected flow");
assert.equal(flowLibVals.flowLibGraph.hasNodes, true, "flow library should expose a flowchart graph for the selected process");
assert.ok(flowLibVals.flowLibGraph.nodes.some(n => n.id === "n1"), "flowchart graph should include the root node");
assert.ok(flowLibVals.flowLibGraph.edges.length > 0, "flowchart graph should include branch edges");
const pxNum = (v) => Number(String(v || "").replace("px", ""));
const graphNodeEdgeOverlaps = (graph) => {
  const nodesById = new Map((graph.nodes || []).map(n => [n.id, {
    id: n.id,
    left: pxNum(n.boxStyle.left),
    top: pxNum(n.boxStyle.top),
    right: pxNum(n.boxStyle.left) + 230,
    bottom: pxNum(n.boxStyle.top) + 104,
  }]));
  const parsePoints = (d) => {
    const nums = (String(d || "").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const pts = [];
    for (let i = 0; i < nums.length - 1; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
    return pts;
  };
  const segmentHits = (a, b, n) => {
    const margin = 5;
    const r = { left: n.left + margin, right: n.right - margin, top: n.top + margin, bottom: n.bottom - margin };
    if (Math.abs(a.x - b.x) < 0.1) {
      if (a.x <= r.left || a.x >= r.right) return false;
      return Math.min(Math.max(a.y, b.y), r.bottom) - Math.max(Math.min(a.y, b.y), r.top) > 1;
    }
    if (Math.abs(a.y - b.y) < 0.1) {
      if (a.y <= r.top || a.y >= r.bottom) return false;
      return Math.min(Math.max(a.x, b.x), r.right) - Math.max(Math.min(a.x, b.x), r.left) > 1;
    }
    return false;
  };
  const issues = [];
  (graph.edges || []).forEach(e => {
    const pts = parsePoints(e.d);
    for (let i = 0; i < pts.length - 1; i++) {
      for (const n of nodesById.values()) {
        if (n.id === e.fromId || n.id === e.toId) continue;
        if (segmentHits(pts[i], pts[i + 1], n)) issues.push({ edge: `${e.fromId}>${e.toId}`, node: n.id, d: e.d });
      }
    }
  });
  return issues;
};
const convergingGraph = c.buildGraph({
  title: "合流レイアウト",
  root: "n1",
  nodes: {
    n1: { kind: "decision", text: "分岐するか？", yes: "n2", no: "n3" },
    n2: { kind: "action", text: "Aを確認", next: "n4" },
    n3: { kind: "action", text: "Bを確認", next: "n4" },
    n4: { kind: "result", text: "合流して完了" },
  },
}, [], []);
const nodeLeft = (id) => Number(String(convergingGraph.nodes.find(n => n.id === id).boxStyle.left).replace("px", ""));
assert.ok(Math.abs(nodeLeft("n2") - nodeLeft("n3")) >= 230, "flowchart layout should keep converging sibling nodes from overlapping");
const yesLabel = convergingGraph.labels.find(l => l.rawText === "はい");
const noLabel = convergingGraph.labels.find(l => l.rawText === "いいえ");
assert.equal(yesLabel.text, "はい", "yes label text should remain plain");
assert.equal(noLabel.text, "いいえ", "no label text should remain plain");
assert.equal(yesLabel.style.color, "#0f835c", "yes labels should be green");
assert.equal(noLabel.style.color, "#c0392b", "no labels should be red");
const yesNoLabelTops = convergingGraph.labels.filter(l => l.rawText === "はい" || l.rawText === "いいえ").map(l => Number(String(l.style.top).replace("px", "")));
assert.equal(new Set(yesNoLabelTops).size, 1, "yes/no labels should share the same branch fold lane");
const branchEdges = convergingGraph.edges.filter(e => e.fromId === "n1" && (e.label === "はい" || e.label === "いいえ"));
const branchStarts = branchEdges.map(e => (String(e.d).match(/M\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/) || []).slice(1, 3).join(","));
assert.equal(new Set(branchStarts).size, 1, "yes/no branch edges should start from the same split point");
assert.ok(branchEdges.every(e => e.pathStyle.markerEnd === "url(#fcArrow)"), "branch edges themselves should be arrows");
assert.ok(branchEdges.every(e => e.pathStyle.stroke === "#b8c0cc"), "branch edge lines should stay neutral; yes/no color belongs to labels");
assert.ok(convergingGraph.edges.some(e => e.isTrunk && e.fromId === "n1"), "multi-branch decisions should have a shared trunk before splitting");
const loopGraph = c.buildGraph({
  title: "戻り線レイアウト",
  root: "n1",
  nodes: {
    n1: { kind: "decision", text: "主電源はONか？", yes: "n2", no: "n3" },
    n2: { kind: "result", text: "確認完了" },
    n3: { kind: "action", text: "主電源をONにする", next: "n1" },
  },
}, [], []);
const backEdges = loopGraph.edges.filter(e => e.isBackEdge);
assert.equal(backEdges.length, 1, "back/cycle edges should be detected explicitly");
assert.equal(backEdges[0].label, "戻る", "unlabeled back edges should get a visible return label");
assert.equal(backEdges[0].pathStyle.strokeDasharray, "6 5", "back edges should be drawn as dashed outer-lane edges");
const maxLoopNodeRight = Math.max(...loopGraph.nodes.map(n => Number(String(n.boxStyle.left).replace("px", "")) + 230));
const returnLabelX = Number(String(loopGraph.labels.find(l => l.text === "戻る").style.left).replace("px", ""));
assert.ok(returnLabelX > maxLoopNodeRight + 24, "return labels should be outside the node column");
assert.deepEqual(graphNodeEdgeOverlaps(loopGraph), [], "back/cycle edge routes should not pass through non-endpoint nodes");
const crossingGraph = c.buildGraph({
  title: "深い合流レイアウト",
  root: "n1",
  nodes: {
    n1: { kind: "decision", text: "分岐するか？", yes: "n2", no: "n3" },
    n2: { kind: "action", text: "Aを確認", next: "n4" },
    n4: { kind: "action", text: "Aの詳細を確認", next: "n5" },
    n3: { kind: "action", text: "Bを確認", next: "n5" },
    n5: { kind: "result", text: "合流して完了" },
  },
}, [], []);
assert.ok(crossingGraph.edges.some(e => e.fromId === "n3" && e.toId === "n5" && e.isDetour), "long cross-column joins should detour around intermediate nodes");
assert.deepEqual(graphNodeEdgeOverlaps(crossingGraph), [], "flowchart edge routes should not pass through non-endpoint nodes");
c.goDb();
let pageVals = c.renderVals();
assert.equal(c.state.stage, "db", "knowledge database navigation should use a main stage");
assert.equal(pageVals.isDbMain, true, "renderVals should expose the database main screen");
assert.equal(pageVals.showDbSidebar, true, "database screen should show database-specific sidebar content");
assert.equal(pageVals.showChatSidebar, false, "consultation history should not show on the database screen");
assert.equal(c.state.dbOpen, false, "database navigation should not open the legacy modal");
assert.equal(html.includes("公開キー pub_..."), false, "database screen should not show public-key input");
assert.equal(html.includes("新規取り込みPDFの保存先"), false, "database screen should not show legacy upload destination selector");
assert.ok(html.includes("dbFolderContextMenu"), "folder rows should expose right-click menu handling");
assert.ok(html.includes('onDoubleClick="{{ dbOpenFolder }}"'), "folder rows should navigate on double-click");
assert.ok(html.includes("dbDeleteConfirmOpen"), "folder deletion should use a confirmation modal");
assert.ok(!html.includes('data-type="folder" data-id="{{ f.id }}" data-name="{{ f.name }}" onClick="{{ dbStartRename }}"'), "folder rows should not expose inline rename icons");
assert.ok(!html.includes('data-id="{{ f.id }}" onClick="{{ delFolder }}" title="削除"'), "folder rows should not expose inline delete icons");
c.dbFolderSingleClick({ currentTarget: { dataset: { id: "f_sales" } } });
assert.equal(c.state.dbSelectedFolder, "f_sales", "single-click should mark the folder as selected");
assert.equal(c.state.dbCurrent, "", "single-click should not navigate to the selected folder");
assert.equal(c.state.dbUploadFolder, "f_sales", "single-click should keep the selected folder available as the save target");
c.dbOpenFolder({ currentTarget: { dataset: { id: "f_sales" } } });
assert.equal(c.state.dbCurrent, "f_sales", "double-click/open should navigate to the selected folder");
c.setState({ dbCurrent: "", dbUploadFolder: "" });
c.dbFolderContextMenu({
  preventDefault() {},
  stopPropagation() {},
  clientX: 20,
  clientY: 30,
  currentTarget: { dataset: { id: "f_quote" }, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
});
assert.equal(c.state.dbSelectedFolder, "f_quote", "right-click should select the target folder");
assert.equal(c.state.dbCurrent, "", "right-click should not navigate to the selected folder");
pageVals = c.renderVals();
assert.equal(pageVals.dbFolderMenuOpen, true, "right-click should open a folder context menu");
c.dbMenuRenameFolder();
pageVals = c.renderVals();
assert.equal(pageVals.dbRenameDialogOpen, true, "folder rename should open a modal dialog");
c.dbRenameInput({ target: { value: "見積リネーム" } });
c.dbCommitRename();
assert.equal(c.state.db.folders.find(f => f.id === "f_quote").name, "見積リネーム", "folder rename modal should persist the new name");
c.dbFolderContextMenu({
  preventDefault() {},
  stopPropagation() {},
  clientX: 20,
  clientY: 30,
  currentTarget: { dataset: { id: "f_quote" }, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
});
c.dbMenuDeleteFolder();
pageVals = c.renderVals();
assert.equal(pageVals.dbDeleteConfirmOpen, true, "folder deletion from context menu should ask for confirmation");
c.dbCancelDelete();
c.dbOpenFolder({ currentTarget: { dataset: { id: "f_quote" } } });
pageVals = c.renderVals();
assert.equal(pageVals.dbCurSources[0].thoughtExtractDisabled, true, "already extracted PDF sources should disable thinking-process extraction");
c.dbFolderContextMenu({
  preventDefault() {},
  stopPropagation() {},
  clientX: 20,
  clientY: 30,
  currentTarget: { dataset: { id: "f_quote" }, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
});
pageVals = c.renderVals();
assert.equal(pageVals.dbFolderMenuExtractDisabled, true, "folders containing extracted sources should disable repeated extraction");
c.goFlowLib();
pageVals = c.renderVals();
assert.equal(c.state.stage, "flowlib", "thinking process navigation should use a main stage");
assert.equal(pageVals.isFlowLibMain, true, "renderVals should expose the thinking process main screen");
assert.equal(pageVals.showFlowSidebar, true, "thinking process screen should show flow-specific sidebar content");
assert.equal(pageVals.showChatSidebar, false, "consultation history should not show on the thinking process screen");
assert.equal(c.state.flowLibOpen, false, "thinking process navigation should not open the legacy modal");
assert.ok(html.includes('data-pane="flow-lib-ai-chat"'), "thinking process flow display should place AI consultation in the right pane");
assert.equal(html.includes(">差分を提案</button>"), false, "proactive diff proposal button should not be shown");
assert.equal(html.includes('title="既存フローへの差分を提案"'), false, "database source rows should not show a flow-diff proposal button");
assert.equal(html.includes('title="このPDFから既存フローへの差分を提案"'), false, "source rows should not show a PDF flow-diff proposal button");
assert.ok(html.includes("thoughtExtractTitle"), "source rows should expose stateful thinking-process extraction controls");
c.goHome();
pageVals = c.renderVals();
assert.equal(pageVals.showChatSidebar, true, "consultation history should show only on AI consultation");

const emptyChat = new globalThis.Component();
emptyChat.state.db = { folders: [], docs: [] };
emptyChat.state.kbSources = [];
emptyChat.state.savedFlows = [];
emptyChat.state.flow = null;
emptyChat.state.curFlowId = null;
emptyChat.state.chatInput = "見積の承認はどう進める？";
emptyChat.hasLLM = () => true;
emptyChat.llmComplete = async (prompt) => {
  if (prompt.includes("入口プランナー")) return '{"plan":["見積承認の進め方を聞いている","業務フロー確認の対象"],"route":"knowledge","needs":["flow"],"reason":"業務手順の質問"}';
  return "{}";
};
emptyChat.chatHarnessLoop = async () => { throw new Error("empty chat should not invoke the agent harness"); };
let emptyAnswer = "";
emptyChat.finishChatMessage = async (msg) => { emptyAnswer = msg.answer || ""; emptyChat.setState({ chatLoading: false }); };
await emptyChat.sendChat();
assert.ok(emptyAnswer.includes("相談に使える保存済みフローまたはナレッジDBがまだありません"), "empty chat should show a setup guidance message instead of a generic processing failure");

const greetingChat = new globalThis.Component();
greetingChat.state.db = c.state.db;
greetingChat.state.kbSources = c.state.kbSources;
greetingChat.state.savedFlows = seededSavedFlows;
greetingChat.state.flow = null;
greetingChat.state.curFlowId = null;
greetingChat.state.chatInput = "こんにちは";
greetingChat.hasLLM = () => true;
greetingChat.chatHarnessLoop = async () => { throw new Error("greeting-only chat should not invoke the agent harness"); };
greetingChat.buildDbChatMessage = async () => { throw new Error("greeting-only chat should not search DB"); };
let greetingLlmCalls = 0;
greetingChat.llmComplete = async (prompt) => {
  greetingLlmCalls += 1;
  if (prompt.includes("入口プランナー")) return '{"plan":["あいさつのみ","フロー/DB確認は不要"],"route":"general","needs":[],"reason":"あいさつのみで、登録済みフロー/DBの確認対象ではない"}';
  return "こんにちは。相談したい内容があれば入力してください。";
};
let greetingAnswer = "";
let greetingTrace = [];
greetingChat.finishChatMessage = async (msg) => { greetingAnswer = msg.answer || ""; greetingTrace = msg.trace || []; greetingChat.setState({ chatLoading: false }); };
await greetingChat.sendChat();
assert.ok(greetingAnswer.includes("こんにちは"), "general chat should answer normally without flow/DB search");
assert.equal(greetingLlmCalls, 2, "general chat should use route classification plus normal response, not the flow/DB harness");
assert.ok(greetingTrace.some(t => String(t.title || "").includes("LLMで判定")), "LLM-backed general chat should expose that planning used LLM");
assert.ok(greetingTrace.some(t => String(t.title || "").includes("LLMに応答生成を依頼")), "LLM-backed general chat should expose that response generation used LLM");

const businessGreeting = new globalThis.Component();
assert.equal(businessGreeting.localChatRoute("こんにちは、見積の承認はどう進める？").route, "knowledge", "greetings with a business question should still use the normal search path");

const apiOpenAiTest = new globalThis.Component();
apiOpenAiTest.state.apiCfg = apiOpenAiTest.normalizeApiCfg({ provider: "openai", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
apiOpenAiTest._apiCfgDraft = apiOpenAiTest.state.apiCfg;
let openAiPrompt = "";
apiOpenAiTest.callOpenAI = async (prompt, cfg) => {
  openAiPrompt = prompt;
  assert.equal(cfg.apiKey, "sk-test", "OpenAI connection test should use the entered API key");
  assert.equal(cfg.model, "gpt-4o-mini", "OpenAI connection test should use the entered model");
  return "接続OK";
};
await apiOpenAiTest.testApiConnection();
assert.ok(openAiPrompt.includes("接続テスト"), "OpenAI connection test should send a short test prompt");
assert.equal(apiOpenAiTest.state.apiTest.ok, true, "successful OpenAI connection test should set ok state");
assert.ok(apiOpenAiTest.state.apiTest.message.includes("OpenAI 接続OK"), "successful OpenAI connection test should show provider success");

const apiMissingKeyTest = new globalThis.Component();
apiMissingKeyTest.state.apiCfg = apiMissingKeyTest.normalizeApiCfg({ provider: "openai", apiKey: "", model: "gpt-4o-mini" });
apiMissingKeyTest._apiCfgDraft = apiMissingKeyTest.state.apiCfg;
let missingKeyCalled = false;
apiMissingKeyTest.callOpenAI = async () => { missingKeyCalled = true; return "接続OK"; };
await apiMissingKeyTest.testApiConnection();
assert.equal(missingKeyCalled, false, "connection test should not call OpenAI without an API key");
assert.equal(apiMissingKeyTest.state.apiTest.ok, false, "missing API key should set failed test state");
assert.ok(apiMissingKeyTest.state.apiTest.message.includes("API Key"), "missing API key should explain the required field");

const apiAzureTest = new globalThis.Component();
apiAzureTest.state.apiCfg = apiAzureTest.normalizeApiCfg({ provider: "azure", apiKey: "az-test", baseUrl: "https://example.openai.azure.com", model: "dep1", apiVersion: "2024-02-15-preview" });
apiAzureTest._apiCfgDraft = apiAzureTest.state.apiCfg;
apiAzureTest.callAzure = async (prompt, cfg) => {
  assert.equal(cfg.apiKey, "az-test", "Azure connection test should use the entered API key");
  assert.equal(cfg.baseUrl, "https://example.openai.azure.com", "Azure connection test should use the entered base URL");
  assert.equal(cfg.model, "dep1", "Azure connection test should use the entered deployment name");
  return "接続OK";
};
await apiAzureTest.testApiConnection();
assert.equal(apiAzureTest.state.apiTest.ok, true, "successful Azure connection test should set ok state");

const capabilityChat = new globalThis.Component();
capabilityChat.state.db = c.state.db;
capabilityChat.state.kbSources = c.state.kbSources;
capabilityChat.state.savedFlows = seededSavedFlows;
capabilityChat.state.flow = null;
capabilityChat.state.curFlowId = null;
capabilityChat.state.chatInput = "どんな内容について回答できる？";
capabilityChat.hasLLM = () => true;
capabilityChat.chatHarnessLoop = async () => { throw new Error("capability question should not invoke the flow/DB harness"); };
capabilityChat.buildDbChatMessage = async () => { throw new Error("capability question should not search DB"); };
capabilityChat.llmComplete = async (prompt) => {
  if (prompt.includes("入口プランナー")) return '{"plan":["ツールの回答範囲を聞いている","保存済みフロー/DBを読む必要はない"],"route":"general","needs":[],"reason":"機能説明の質問"}';
  return "保存済みフローを使った手順・判断の確認、ナレッジDBを使った資料根拠の確認、登録内容に関係しない一般的な使い方の質問に回答できます。";
};
let capabilityAnswer = "";
capabilityChat.finishChatMessage = async (msg) => { capabilityAnswer = msg.answer || ""; capabilityChat.setState({ chatLoading: false }); };
await capabilityChat.sendChat();
assert.ok(capabilityAnswer.includes("保存済みフロー") && capabilityAnswer.includes("ナレッジDB"), "capability question should be answered as general chat");

const noLlmCapabilityChat = new globalThis.Component();
noLlmCapabilityChat.state.db = c.state.db;
noLlmCapabilityChat.state.kbSources = c.state.kbSources;
noLlmCapabilityChat.state.savedFlows = seededSavedFlows;
noLlmCapabilityChat.state.flow = null;
noLlmCapabilityChat.state.curFlowId = null;
noLlmCapabilityChat.state.chatInput = "あなたはどんな質問について回答できますか？";
let noLlmCapabilityAnswer = "";
let noLlmCapabilityTrace = [];
noLlmCapabilityChat.finishChatMessage = async (msg) => { noLlmCapabilityAnswer = msg.answer || ""; noLlmCapabilityTrace = msg.trace || []; noLlmCapabilityChat.setState({ chatLoading: false }); };
await noLlmCapabilityChat.sendChat();
assert.ok(noLlmCapabilityAnswer.includes("保存済みフロー") && noLlmCapabilityAnswer.includes("現在AIが利用できない"), "no-LLM capability question should receive a useful capability answer, not the generic receipt fallback");
assert.ok(noLlmCapabilityTrace.some(t => String(t.title || "").includes("AI未設定のためローカル判定")), "no-LLM general route should expose that LLM planning was not used");

const noLlmGreetingChat = new globalThis.Component();
noLlmGreetingChat.state.chatInput = "こんにちは";
let noLlmGreetingAnswer = "";
noLlmGreetingChat.finishChatMessage = async (msg) => { noLlmGreetingAnswer = msg.answer || ""; noLlmGreetingChat.setState({ chatLoading: false }); };
await noLlmGreetingChat.sendChat();
assert.ok(!noLlmGreetingAnswer.includes("入力は受け取れています"), "no-LLM greeting should not fall back to the generic receipt message");

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
const unsafeMarkdown = [
  "<script>window.xss = true</script>",
  "<img src=x onerror=\"window.xss = true\">",
  "[危険リンク](javascript:window.xss = true)",
  "[安全リンク](https://example.com/path)",
  "",
  "```html",
  "<button onclick=\"window.xss = true\">run</button>",
  "```",
].join("\n");
const unsafeHtml = c.markdownToHtml(unsafeMarkdown);
assert.equal(unsafeHtml.includes("<script"), false, "markdown renderer should not render raw script tags as HTML");
assert.equal(unsafeHtml.includes("<img"), false, "markdown renderer should not render raw HTML tags with event handlers");
assert.equal(unsafeHtml.includes("<button"), false, "markdown renderer should escape HTML inside code blocks");
assert.equal(unsafeHtml.includes("<a href=\"javascript:"), false, "markdown renderer should not create javascript: links");
assert.ok(unsafeHtml.includes("&lt;script&gt;window.xss = true&lt;/script&gt;"), "markdown renderer should preserve script text only as escaped content");
assert.ok(unsafeHtml.includes("&lt;img src=x onerror=&quot;window.xss = true&quot;&gt;"), "markdown renderer should preserve event-handler text only as escaped content");
assert.ok(unsafeHtml.includes("[危険リンク](javascript:window.xss = true)"), "unsupported javascript markdown links should remain inert text");
assert.ok(unsafeHtml.includes('<a href="https://example.com/path" target="_blank" rel="noopener noreferrer">安全リンク</a>'), "safe https markdown links should still render as anchors");
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

const sourceWithPdfStoreFailure = { id: "kb_pdf_fail", name: "保存失敗.pdf" };
c.putPdfBlob = async () => { throw new Error("quota exceeded"); };
const attachedPdfSource = await c.attachPdfToSource(sourceWithPdfStoreFailure, new Blob(["%PDF-1.4"], { type: "application/pdf" }), "asset://pdf");
assert.equal(attachedPdfSource.pdfUrl, "asset://pdf", "PDF source should keep the asset URL even when durable blob storage fails");
assert.equal(attachedPdfSource.pdfBlobKey, undefined, "PDF source should not claim a durable blob key after storage failure");
assert.ok(attachedPdfSource.pdfStoreError.includes("quota exceeded"), "PDF storage write failures should surface on the source record");

const granularityPolicy = c.flowGranularityPolicyText();
assert.ok(granularityPolicy.includes("ページ単位・質問単位・型番単位"), "granularity policy should explicitly discourage small flow proliferation");
assert.ok(c.buildPrompt("見積相談").includes("# フロー粒度ポリシー"), "text/csv flow generation prompt should include granularity policy");
assert.ok(c.buildMergePrompt("特約店経由なら引き継ぐ", quoteFlowRec.flow).includes("# フロー粒度ポリシー"), "merge prompt should include granularity policy");
assert.ok(c.buildClusterPrompt([{ page: 1, category: "procedure", summary: "申請手順", keywords: ["申請"] }]).includes("最大12件"), "PDF topic clustering should cap broad topics");
assert.ok(c.buildPdfFlowPrompt({ title: "申請可否の判断", symptom: "申請できるか判断する" }, "[p1] 条件を確認する").includes("# フロー粒度ポリシー"), "PDF flow prompt should include granularity policy");
const coveragePrompt = c.buildPdfCoveragePrompt(
  [{ page: 2, category: "procedure", summary: "例外条件では上長確認を行う", keywords: ["例外"], conditions: [{ if: "例外条件", then: "上長確認" }] }],
  [{ title: "申請可否の判断", root: "n1", nodes: { n1: { kind: "action", text: "申請内容を確認", pages: [1] } } }],
);
assert.ok(coveragePrompt.includes("保存前の補完計画"), "PDF coverage audit prompt should run before saving as part of initial generation");
assert.ok(coveragePrompt.includes("merge_into_flow"), "PDF coverage audit should prefer merging missing process content into existing flows");
assert.ok(coveragePrompt.includes("create_flow は、開始条件・判断軸・完了状態が既存フローと明確に異なり"), "PDF coverage audit should discourage flow proliferation");
const coverageActions = c.normalizePdfCoverageActions({
  actions: [
    { type: "db_only", pages: [9], reason: "参照のみ" },
    { type: "merge_into_flow", flowIndex: 0, title: "例外確認", pages: [2], reason: "手順が未反映" },
    { type: "create_flow", title: "範囲外", pages: [999], reason: "存在しないページ" },
  ],
}, [{ title: "申請可否の判断", nodes: {} }], [{ page: 2 }]);
assert.equal(coverageActions.length, 1, "coverage normalization should keep actionable in-document gaps only");
assert.equal(coverageActions[0].type, "merge_into_flow", "coverage normalization should preserve merge actions");
let coverageCall = 0;
c.hasLLM = () => true;
c.llmComplete = async (prompt) => {
  coverageCall += 1;
  if (prompt.includes("カバレッジを監査")) return '{"actions":[{"type":"merge_into_flow","flowIndex":0,"title":"例外条件","symptom":"例外時の確認","pages":[2],"reason":"例外時の上長確認が未反映"}]}';
  return '{"upsert":{"n2":{"kind":"action","text":"例外条件を確認","why":"通常手順と分けるため","pages":[2],"next":"n3"},"n3":{"kind":"result","text":"上長確認へ回す","pages":[2]}}}';
};
const completedFlows = await c.auditAndCompletePdfFlows(
  [{ title: "申請可否の判断", root: "n1", nodes: { n1: { kind: "action", text: "申請内容を確認", pages: [1], next: "n2" }, n2: { kind: "result", text: "受理する", pages: [1] } } }],
  { index: [{ page: 2, category: "procedure", summary: "例外条件では上長確認を行う", conditions: [{ if: "例外条件", then: "上長確認" }] }], pageText: { 2: "例外条件では上長確認を行う。" }, mdByPage: {}, vision: false, kb: null, progressBase: 1 },
);
assert.equal(coverageCall, 2, "coverage completion should audit once and merge missing content once");
assert.equal(completedFlows.length, 1, "coverage completion should merge into the existing flow instead of creating a new one");
assert.ok(completedFlows[0].nodes.n3, "coverage completion should add missing process nodes to the existing flow");

console.log("flow search verification passed");

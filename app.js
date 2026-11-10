/* app.js — 你的應用程式邏輯（擴充區，可自由修改；靜態畫面結構寫在 index.html 的 #appRoot 內）
 *
 * 契約：window.App = { mount(root, ctx) }，只透過 ctx 取得資料與使用者。
 */
(function () {
  'use strict';

  var COL_HIRES = 'hires';
  var COL_TASKS = 'tasks';
  var COL_REVIEWS = 'reviews';
  var COL_TEMPLATES = 'templates';
  var UI_PREF_HIRE = 'mws:readiness-tracker-app:ui:selectedHire';
  var UI_PREF_TPLSET = 'mws:readiness-tracker-app:ui:selectedTplSet';
  var DEFAULT_TPL_SET = 'Teams';

  var EVAL_META = {
    on_track: { labelZh: '符合預期 (On Track)', labelEn: 'On Track', badge: 'badge-success', icon: 'fa-circle-check' },
    ahead: { labelZh: '進度超前 (Ahead)', labelEn: 'Ahead', badge: 'badge-info', icon: 'fa-rocket' },
    attention: { labelZh: '需加強關注 (Needs Attention)', labelEn: 'Needs Attention', badge: 'badge-warning', icon: 'fa-triangle-exclamation' },
    behind: { labelZh: '進度落後 (Behind)', labelEn: 'Behind', badge: 'badge-error', icon: 'fa-circle-exclamation' }
  };

  var TASK_STATUS_META = {
    pending: { label: '⏳ Pending', badge: 'badge-warning badge-soft', next: 'completed', isDone: false },
    completed: { label: '✅ Completed', badge: 'badge-success badge-soft', next: 'pending', isDone: true },
    final_eval: { label: '🏁 Final Evaluation', badge: 'badge-primary badge-soft', next: 'completed', isDone: false },
    todo: { label: '⏳ Pending', badge: 'badge-warning badge-soft', next: 'completed', isDone: false },
    in_progress: { label: '⏳ Pending', badge: 'badge-warning badge-soft', next: 'completed', isDone: false },
    done: { label: '✅ Completed', badge: 'badge-success badge-soft', next: 'pending', isDone: true }
  };

  function h(tag, props) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') e.textContent = props[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]);
      else if (props[k] != null) e.setAttribute(k, props[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function safeUrl(raw) {
    if (!raw) return null;
    try {
      var u = new URL(String(raw).trim());
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (_) {}
    return null;
  }

  function formatIsoDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseIsoDate(dateStr) {
    if (!dateStr) return null;
    var parts = String(dateStr).split('-');
    if (parts.length !== 3) return null;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  // 若落在週末，自動順延至下一個週一（工作日）
  function ensureWorkday(d) {
    var copy = new Date(d.getTime());
    var dow = copy.getDay();
    if (dow === 6) copy.setDate(copy.getDate() + 2);
    else if (dow === 0) copy.setDate(copy.getDate() + 1);
    return copy;
  }

  // 從起始日往後推 N 個工作日（自動跳過週六、週日）
  function addWorkdays(startDate, workdaysToAdd) {
    var d = ensureWorkday(startDate);
    var remaining = Math.max(0, Number(workdaysToAdd) || 0);
    while (remaining > 0) {
      d.setDate(d.getDate() + 1);
      var dow = d.getDay();
      if (dow !== 0 && dow !== 6) {
        remaining--;
      }
    }
    return d;
  }

  // 輸入開始日期後，自動計算滿 5 個工作日的結束日期（例如週一 11/30 → 週五 12/04）
  function calcDefaultWorkEndDate(startDateStr) {
    var d = parseIsoDate(startDateStr);
    if (!d) return '';
    return formatIsoDate(addWorkdays(d, 4));
  }

  function calcWeekRangeFromHireStart(hireStartDate, weekOrder) {
    var d = parseIsoDate(hireStartDate);
    if (!d) return { startDate: '', endDate: '' };
    var idx = Math.max(0, (Number(weekOrder) || 1) - 1);
    var weekStart = addWorkdays(d, idx * 5);
    var weekEnd = addWorkdays(weekStart, 4);
    return { startDate: formatIsoDate(weekStart), endDate: formatIsoDate(weekEnd) };
  }

  window.App = {
    mount: function (root, ctx) {
      var $ = function (id) { return root.querySelector('#' + id); };
      var sync = ctx.Sync;
      var i18n = ctx.I18n || { lang: 'zh', t: function (z) { return z; }, onChange: function () {} };
      var canWrite = !!ctx.canWrite;
      var curSyncStatus = 'loading';

      function getStatusLabel(s) {
        var map = {
          loading: i18n.t('載入中…', 'Loading…'),
          live: i18n.t('已同步', 'Synced'),
          offline: i18n.t('離線，重連中…', 'Offline, reconnecting…'),
          denied: i18n.t('無讀取權限', 'Permission denied'),
          auth: i18n.t('登入已失效', 'Session expired')
        };
        return map[s] || s;
      }

      var hiresMap = {};
      var tasksMap = {};
      var reviewsMap = {};
      var templatesMap = {};
      var localTplSets = [];
      var selectedTplSet = DEFAULT_TPL_SET;
      try {
        selectedTplSet = localStorage.getItem(UI_PREF_TPLSET) || DEFAULT_TPL_SET;
      } catch (_) {}
      var selectedHireId = '';
      try {
        selectedHireId = localStorage.getItem(UI_PREF_HIRE) || '';
      } catch (_) {}

      // selectedFilter: 'all' 或數字週次/階段 (1..N)
      var selectedFilter = 'all';
      var selectedReviewWeek = 1;
      var editingHireId = null;
      var editingTaskId = null;
      var isEditingReview = false;

      var statusEl = $('statusText');
      var errEl = $('errBox');
      var refreshBtn = $('refreshBtn');
      var addHireBtn = $('addHireBtn');
      var hireSelect = $('hireSelect');
      var hireActions = $('hireActions');
      var applyTemplateBtn = $('applyTemplateBtn');
      var manageTemplateBtn = $('manageTemplateBtn');
      var editHireBtn = $('editHireBtn');
      var deleteHireBtn = $('deleteHireBtn');
      var hireSummary = $('hireSummary');
      var emptyHireState = $('emptyHireState');
      var workspace = $('workspace');

      var infoHireName = $('infoHireName');
      var infoHireRole = $('infoHireRole');
      var infoMentor = $('infoMentor');
      var infoStartDate = $('infoStartDate');
      var infoTaskRate = $('infoTaskRate');
      var infoTaskCount = $('infoTaskCount');
      var infoLatestEval = $('infoLatestEval');
      var infoLatestWeek = $('infoLatestWeek');

      var weekTabs = $('weekTabs');
      var quickAddCycleBtn = $('quickAddCycleBtn');
      var deleteCycleBtn = $('deleteCycleBtn');
      var autoDateBtn = $('autoDateBtn');
      var addTaskBtn = $('addTaskBtn');
      var weekTaskTitle = $('weekTaskTitle');
      var weekProgressBadge = $('weekProgressBadge');
      var emptyTaskState = $('emptyTaskState');
      var tableWrap = $('tableWrap');
      var taskTableBody = $('taskTableBody');

      var weekReviewTitle = $('weekReviewTitle');
      var reviewStageSelect = $('reviewStageSelect');
      var reviewCurrentBadge = $('reviewCurrentBadge');
      var editReviewBtn = $('editReviewBtn');
      var reviewDisplay = $('reviewDisplay');
      var reviewForm = $('reviewForm');
      var reviewStatusInput = $('reviewStatusInput');
      var reviewMentorInput = $('reviewMentorInput');
      var reviewCommentInput = $('reviewCommentInput');
      var reviewSummaryInput = $('reviewSummaryInput');
      var cancelReviewBtn = $('cancelReviewBtn');

      var hireModal = $('hireModal');
      var hireModalTitle = $('hireModalTitle');
      var hireForm = $('hireForm');
      var hireNameInput = $('hireNameInput');
      var hireMentorInput = $('hireMentorInput');
      var hireRoleInput = $('hireRoleInput');
      var hireDateInput = $('hireDateInput');
      var hireSeedWrap = $('hireSeedWrap');
      var hireSeedCheckbox = $('hireSeedCheckbox');
      var hireModalCancel = $('hireModalCancel');

      var taskModal = $('taskModal');
      var taskModalTitle = $('taskModalTitle');
      var taskForm = $('taskForm');
      var taskWeekInput = $('taskWeekInput');
      var taskTimelineInput = $('taskTimelineInput');
      var taskStartDateInput = $('taskStartDateInput');
      var taskEndDateInput = $('taskEndDateInput');
      var taskStatusInput = $('taskStatusInput');
      var taskTitleInput = $('taskTitleInput');
      var taskTopicsInput = $('taskTopicsInput');
      var taskResourceTextInput = $('taskResourceTextInput');
      var taskResourceInput = $('taskResourceInput');
      var taskNoteInput = $('taskNoteInput');
      var taskModalCancel = $('taskModalCancel');

      var tplListModal = $('tplListModal');
      var saveCurrentAsTplBtn = $('saveCurrentAsTplBtn');
      var addTplItemBtn = $('addTplItemBtn');
      var tplTableBody = $('tplTableBody');
      var tplItemForm = $('tplItemForm');
      var tplFormTitle = $('tplFormTitle');
      var tplWeekInput = $('tplWeekInput');
      var tplTimelineInput = $('tplTimelineInput');
      var tplStatusInput = $('tplStatusInput');
      var tplPhaseInput = $('tplPhaseInput');
      var tplTopicsInput = $('tplTopicsInput');
      var tplResourcesInput = $('tplResourcesInput');
      var tplResourceUrlInput = $('tplResourceUrlInput');
      var tplRemarksInput = $('tplRemarksInput');
      var tplFormCancelBtn = $('tplFormCancelBtn');
      var tplListCloseBtn = $('tplListCloseBtn');
      var editingTplId = null;
      var applyTplSelect = $('applyTplSelect');
      var hireTplSelect = $('hireTplSelect');
      var tplSetSelect = $('tplSetSelect');
      var tplNewSetInput = $('tplNewSetInput');
      var tplNewSetBtn = $('tplNewSetBtn');
      var tplImportCsvBtn = $('tplImportCsvBtn');
      var tplImportCsvInput = $('tplImportCsvInput');
      var tplDeleteSetBtn = $('tplDeleteSetBtn');
      var confirmModal = $('confirmModal');
      var confirmModalMsg = $('confirmModalMsg');
      var confirmPromptWrap = $('confirmPromptWrap');
      var confirmPromptInput = $('confirmPromptInput');
      var confirmCancelBtn = $('confirmCancelBtn');
      var confirmOkBtn = $('confirmOkBtn');
      var pendingConfirmCallback = null;

      function askConfirm(messageText, onOk, opts) {
        opts = opts || {};
        confirmModalMsg.textContent = messageText;
        if (opts.promptDate) {
          confirmPromptWrap.hidden = false;
          confirmPromptInput.value = opts.defaultDate || new Date().toISOString().slice(0, 10);
        } else {
          confirmPromptWrap.hidden = true;
        }
        confirmOkBtn.className = 'btn btn-sm ' + (opts.danger ? 'btn-error' : 'btn-primary');
        confirmOkBtn.textContent = opts.okLabel || i18n.t('確認執行', 'Confirm');
        pendingConfirmCallback = function () {
          var val = opts.promptDate ? (confirmPromptInput.value || '').trim() : true;
          onOk(val);
        };
        confirmModal.showModal();
      }

      if (confirmCancelBtn) {
        confirmCancelBtn.addEventListener('click', function () {
          pendingConfirmCallback = null;
          confirmModal.close();
        });
      }
      if (confirmOkBtn) {
        confirmOkBtn.addEventListener('click', function () {
          var cb = pendingConfirmCallback;
          pendingConfirmCallback = null;
          confirmModal.close();
          if (cb) cb();
        });
      }

      function showErr(e) {
        errEl.hidden = false;
        errEl.textContent = e && e.kind === 'denied'
          ? i18n.t('沒有權限執行這個動作（角色不足或存取已被撤銷）', 'Permission denied (insufficient role or access revoked)')
          : (e && e.message) || String(e);
      }

      function run(promise) {
        errEl.hidden = true;
        return promise.catch(showErr);
      }

      function saveSelectedHirePref(id) {
        try {
          if (id) localStorage.setItem(UI_PREF_HIRE, id);
          else localStorage.removeItem(UI_PREF_HIRE);
        } catch (_) {}
      }

      function getSortedHireIds() {
        return Object.keys(hiresMap).sort(function (a, b) {
          return (hiresMap[a].createdAt || 0) - (hiresMap[b].createdAt || 0);
        });
      }

      function parseCsv(text) {
        var rows = [], row = [], cur = '', inQ = false;
        text = text.replace(/^\uFEFF/, '');
        for (var i = 0; i < text.length; i++) {
          var ch = text[i];
          if (inQ) {
            if (ch === '"') {
              if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
            } else cur += ch;
          } else if (ch === '"') inQ = true;
          else if (ch === ',') { row.push(cur); cur = ''; }
          else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cur); cur = '';
            rows.push(row); row = [];
          } else cur += ch;
        }
        if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
        return rows;
      }

      // 每個 Category 對應一個範本階段（一週），Title 條列成 Key Topics
      function csvToTemplateStages(text) {
        var rows = parseCsv(text);
        if (!rows.length) return [];
        var head = rows[0].map(function (c) { return c.trim(); });
        var iCat = head.indexOf('Category');
        var iTitle = head.indexOf('Title');
        if (iCat < 0 || iTitle < 0) return [];
        var iDur = head.indexOf('Duration');
        var iDoc = head.indexOf('Documents');
        var iMan = head.indexOf('Mandatory');
        var groups = {};
        rows.slice(1).forEach(function (r) {
          var cat = (r[iCat] || '').trim();
          var title = (r[iTitle] || '').trim();
          if (!cat || !title) return;
          var line = '- ' + title;
          var dur = iDur >= 0 ? (r[iDur] || '').trim() : '';
          if (dur) line += ' (' + dur + ')';
          if (iMan >= 0 && /^false$/i.test((r[iMan] || '').trim())) line += ' [Optional]';
          var doc = iDoc >= 0 ? (r[iDoc] || '').replace(/\s+/g, ' ').trim() : '';
          if (doc) line += ' ' + doc;
          (groups[cat] = groups[cat] || []).push(line);
        });
        return Object.keys(groups).sort(function (a, b) {
          return a.localeCompare(b, undefined, { numeric: true });
        }).map(function (cat) {
          return { phase: cat.slice(0, 200), keyTopics: groups[cat].join('\n').slice(0, 8000) };
        });
      }

      function tplSetOf(t) {
        return (t && t.setName) || DEFAULT_TPL_SET;
      }

      function getTemplateSetNames() {
        var names = {};
        Object.keys(templatesMap).forEach(function (k) {
          if (templatesMap[k]) names[tplSetOf(templatesMap[k])] = true;
        });
        localTplSets.forEach(function (n) { names[n] = true; });
        if (!Object.keys(names).length) names[DEFAULT_TPL_SET] = true;
        return Object.keys(names).sort(function (a, b) { return a.localeCompare(b); });
      }

      function setSelectedTplSet(name) {
        selectedTplSet = name;
        try { localStorage.setItem(UI_PREF_TPLSET, name); } catch (_) {}
        renderTplSetSelects();
        renderTemplateModalList();
      }

      function renderTplSetSelects() {
        var names = getTemplateSetNames();
        if (names.indexOf(selectedTplSet) === -1) selectedTplSet = names[0];
        [applyTplSelect, hireTplSelect, tplSetSelect].forEach(function (sel) {
          if (!sel) return;
          sel.textContent = '';
          names.forEach(function (n) { sel.appendChild(h('option', { value: n, text: n })); });
          sel.value = selectedTplSet;
        });
      }

      function getSortedTemplates() {
        return Object.keys(templatesMap).map(function (k) {
          var item = templatesMap[k];
          return item && tplSetOf(item) === selectedTplSet ? Object.assign({ _id: k }, item) : null;
        }).filter(Boolean).sort(function (a, b) {
          return (Number(a.order) || Number(a.week) || 0) - (Number(b.order) || Number(b.week) || 0);
        });
      }

      function getHireTasks(hireId) {
        var list = [];
        Object.keys(tasksMap).forEach(function (id) {
          var t = tasksMap[id];
          if (t && t.hireId === hireId) {
            list.push({ id: id, data: t });
          }
        });
        list.sort(function (a, b) {
          var wa = Number(a.data.week) || 1;
          var wb = Number(b.data.week) || 1;
          if (wa !== wb) return wa - wb;
          return (a.data.createdAt || 0) - (b.data.createdAt || 0);
        });
        return list;
      }

      function getHireReviews(hireId) {
        var mapByWeek = {};
        Object.keys(reviewsMap).forEach(function (id) {
          var r = reviewsMap[id];
          if (r && r.hireId === hireId && r.week) {
            mapByWeek[Number(r.week)] = { id: id, data: r };
          }
        });
        return mapByWeek;
      }

      function getStageListForHire(hireId, allTasks, reviewsByWeek) {
        var stageMap = {};
        allTasks.forEach(function (item) {
          var w = Number(item.data.week) || 1;
          if (!stageMap[w]) {
            var firstLine = String(item.data.timeline || ('Week ' + w)).split('\n')[0].trim();
            stageMap[w] = {
              week: w,
              shortLabel: firstLine || ('Stage ' + w),
              phase: item.data.phase || item.data.title || ''
            };
          }
        });
        Object.keys(reviewsByWeek).forEach(function (wKey) {
          var w = Number(wKey) || 1;
          if (!stageMap[w]) {
            stageMap[w] = { week: w, shortLabel: 'Stage ' + w, phase: '' };
          }
        });
        var weeks = Object.keys(stageMap).map(Number).sort(function (a, b) { return a - b; });
        if (!weeks.length) {
          for (var i = 1; i <= 5; i++) {
            stageMap[i] = { week: i, shortLabel: i === 5 ? 'Wrap-up' : ('Week ' + i), phase: '' };
            weeks.push(i);
          }
        }
        return weeks.map(function (w) { return stageMap[w]; });
      }

      function applyCurriculumTemplateToHire(hireId, hireStartDate, overwriteExisting) {
        var tpls = getSortedTemplates();
        if (!tpls.length) {
          showErr(new Error(i18n.t('目前資料庫中尚無預設課綱範本（/data/templates）', 'No default curriculum template found in database (/data/templates)')));
          return Promise.resolve();
        }
        var removePromise = Promise.resolve();
        if (overwriteExisting) {
          var oldTasks = getHireTasks(hireId);
          var oldRevs = getHireReviews(hireId);
          var delOps = oldTasks.map(function (t) { return sync.remove(COL_TASKS, t.id); });
          Object.keys(oldRevs).forEach(function (wkKey) {
            delOps.push(sync.remove(COL_REVIEWS, oldRevs[wkKey].id));
          });
          removePromise = Promise.all(delOps);
        }
        var baseDate = hireStartDate || (hiresMap[hireId] && hiresMap[hireId].startDate) || '';
        return removePromise.then(function () {
          var now = Date.now();
          var promises = tpls.map(function (tpl, idx) {
            var taskId = sync.newId();
            var wk = Number(tpl.week) || (idx + 1);
            var range = calcWeekRangeFromHireStart(baseDate, wk);
            return sync.save(COL_TASKS, taskId, {
              hireId: hireId,
              week: wk,
              timeline: tpl.timeline || ('Week ' + wk),
              startDate: range.startDate || '',
              endDate: range.endDate || '',
              phase: tpl.phase || '',
              title: tpl.phase || '',
              keyTopics: tpl.keyTopics || '',
              resources: tpl.resources || '',
              resourceUrl: tpl.resourceUrl || '',
              remarks: tpl.remarks || '',
              traineeNote: tpl.remarks || '',
              status: tpl.defaultStatus || 'pending',
              createdAt: now + idx,
              updatedAt: now + idx,
              updatedBy: (ctx.session && ctx.session.name) || ''
            });
          });
          return Promise.all(promises);
        });
      }

      // 依據某個階段的日期變更，自動往後遞推後續所有週期（Week N+1 接續 Week N 結束日的下一個工作日，並維持每週 5 個工作日）
      function buildCascadedTaskDateUpdates(hireId, anchorWeek, anchorEndDateStr) {
        var endD = parseIsoDate(anchorEndDateStr);
        if (!endD) return [];
        var allTasks = getHireTasks(hireId);
        // 整理所有大於 anchorWeek 的週次（由小到大）
        var futureWeeks = [];
        allTasks.forEach(function (item) {
          var w = Number(item.data.week) || 1;
          if (w > anchorWeek && futureWeeks.indexOf(w) === -1) {
            futureWeeks.push(w);
          }
        });
        futureWeeks.sort(function (a, b) { return a - b; });

        var prevEnd = endD;
        var weekRangeMap = {};
        futureWeeks.forEach(function (wk) {
          var nextStart = addWorkdays(prevEnd, 1);
          var nextEnd = addWorkdays(nextStart, 4);
          weekRangeMap[wk] = {
            startDate: formatIsoDate(nextStart),
            endDate: formatIsoDate(nextEnd)
          };
          prevEnd = nextEnd;
        });

        var promises = [];
        var now = Date.now();
        allTasks.forEach(function (item) {
          var w = Number(item.data.week) || 1;
          var r = weekRangeMap[w];
          if (r && (item.data.startDate !== r.startDate || item.data.endDate !== r.endDate)) {
            promises.push(sync.save(COL_TASKS, item.id, {
              startDate: r.startDate,
              endDate: r.endDate,
              updatedAt: now
            }));
          }
        });
        return promises;
      }

      // 取得某個目標週次 (targetWeek) 的預設起訖日：優先從前一個週次延伸下一個工作日，否則從學員開始日推算
      function calcDefaultRangeForTargetWeek(hireId, targetWeek) {
        var wk = Math.max(1, Number(targetWeek) || 1);
        var allTasks = getHireTasks(hireId);
        // 尋找小於 wk 且最接近的已有日期階段
        var bestPrevWeek = 0;
        var bestPrevEnd = null;
        allTasks.forEach(function (item) {
          var w = Number(item.data.week) || 1;
          if (w < wk && w >= bestPrevWeek) {
            var ed = parseIsoDate(item.data.endDate) || (item.data.startDate ? addWorkdays(parseIsoDate(item.data.startDate), 4) : null);
            if (ed) {
              bestPrevWeek = w;
              bestPrevEnd = ed;
            }
          }
        });
        if (bestPrevEnd) {
          var gapWeeks = Math.max(1, wk - bestPrevWeek);
          var curEnd = bestPrevEnd;
          var curStart = null;
          for (var i = 0; i < gapWeeks; i++) {
            curStart = addWorkdays(curEnd, 1);
            curEnd = addWorkdays(curStart, 4);
          }
          return {
            startDate: formatIsoDate(curStart),
            endDate: formatIsoDate(curEnd)
          };
        }
        var currentHire = hiresMap[hireId] || {};
        return calcWeekRangeFromHireStart(currentHire.startDate, wk);
      }
      function makeEvalBadge(statusKey) {
        var meta = EVAL_META[statusKey] || EVAL_META.on_track;
        return h('span', { class: 'badge badge-sm gap-1 ' + meta.badge },
          h('i', { class: 'fa-solid ' + meta.icon, 'aria-hidden': 'true' }),
          i18n.t(meta.labelZh, meta.labelEn)
        );
      }

      function isTaskDone(st) {
        var meta = TASK_STATUS_META[st];
        return meta ? meta.isDone : false;
      }

      function renderAll() {
        renderTplSetSelects();
        statusEl.textContent = getStatusLabel(curSyncStatus);
        var hireIds = getSortedHireIds();
        if (!selectedHireId || !hiresMap[selectedHireId]) {
          selectedHireId = hireIds[0] || '';
          saveSelectedHirePref(selectedHireId);
        }

        hireSelect.textContent = '';
        if (!hireIds.length) {
          hireSelect.appendChild(h('option', { value: '', text: i18n.t('尚無學員資料', 'No learners yet') }));
          hireSelect.disabled = true;
          hireActions.hidden = true;
          hireSummary.hidden = true;
          emptyHireState.hidden = false;
          workspace.hidden = true;
          return;
        }

        hireSelect.disabled = false;
        emptyHireState.hidden = true;
        workspace.hidden = false;
        hireSummary.hidden = false;
        hireActions.hidden = !canWrite;

        hireIds.forEach(function (id) {
          var hr = hiresMap[id];
          var label = (hr.name || i18n.t('未命名', 'Unnamed')) + (hr.mentor ? ' (Mentor: ' + hr.mentor + ')' : '');
          var opt = h('option', { value: id, text: label });
          if (id === selectedHireId) opt.selected = true;
          hireSelect.appendChild(opt);
        });

        var currentHire = hiresMap[selectedHireId];
        var allTasks = getHireTasks(selectedHireId);
        var reviewsByWeek = getHireReviews(selectedHireId);
        var stages = getStageListForHire(selectedHireId, allTasks, reviewsByWeek);

        // 統計資訊
        infoHireName.textContent = currentHire.name || '-';
        infoHireRole.textContent = currentHire.roleTitle || i18n.t('未填寫部門', 'Team not specified');
        infoMentor.textContent = currentHire.mentor || '-';
        infoStartDate.textContent = currentHire.startDate
          ? (i18n.t('開始日：', 'Start: ') + currentHire.startDate)
          : i18n.t('未設定開始日', 'Start date not set');

        var totalCount = allTasks.length;
        var doneCount = allTasks.filter(function (t) { return isTaskDone(t.data.status); }).length;
        var rate = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
        infoTaskRate.textContent = rate + '%';
        infoTaskCount.textContent = doneCount + ' / ' + totalCount + i18n.t(' 階段完成', ' stages done');

        var reviewedWeeks = Object.keys(reviewsByWeek).map(Number).sort(function (a, b) { return b - a; });
        infoLatestEval.textContent = '';
        if (reviewedWeeks.length > 0) {
          var latestW = reviewedWeeks[0];
          var latestRev = reviewsByWeek[latestW].data;
          infoLatestEval.appendChild(makeEvalBadge(latestRev.status));
          var matchedStage = stages.find(function (s) { return s.week === latestW; });
          var stageLabel = matchedStage ? matchedStage.shortLabel : ('Stage ' + latestW);
          infoLatestWeek.textContent = stageLabel + (latestRev.updatedBy ? ' · ' + latestRev.updatedBy : '');
        } else {
          infoLatestEval.textContent = i18n.t('尚未評估', 'Not evaluated');
          infoLatestWeek.textContent = i18n.t('尚無評估紀錄', 'No checkpoint yet');
        }

        // 渲染上方篩選 Tabs（全部總覽 + 各階段）
        weekTabs.textContent = '';
        var allTabBtn = h('button', {
          type: 'button',
          role: 'tab',
          class: 'tab gap-1.5 ' + (selectedFilter === 'all' ? 'tab-active font-semibold' : ''),
          onclick: function () {
            selectedFilter = 'all';
            renderAll();
          }
        }, i18n.t('全部階段總覽', 'All Stages') + ' (' + doneCount + '/' + totalCount + ')');
        weekTabs.appendChild(allTabBtn);

        stages.forEach(function (stObj) {
          var wk = stObj.week;
          var wkRev = reviewsByWeek[wk];
          var btnClass = 'tab gap-1.5 ' + (selectedFilter === wk ? 'tab-active font-semibold' : '');
          var tabBtn = h('button', {
            type: 'button',
            role: 'tab',
            class: btnClass,
            onclick: function () {
              selectedFilter = wk;
              selectedReviewWeek = wk;
              isEditingReview = false;
              renderAll();
            }
          }, stObj.shortLabel);

          if (wkRev && EVAL_META[wkRev.data.status]) {
            tabBtn.appendChild(h('i', { class: 'fa-solid ' + EVAL_META[wkRev.data.status].icon + ' text-xs', 'aria-hidden': 'true' }));
          }
          weekTabs.appendChild(tabBtn);
        });

        if (canWrite) {
          quickAddCycleBtn.hidden = false;
          autoDateBtn.hidden = !allTasks.length;
          deleteCycleBtn.hidden = (selectedFilter === 'all');
        } else {
          quickAddCycleBtn.hidden = true;
          autoDateBtn.hidden = true;
          deleteCycleBtn.hidden = true;
        }

        // 渲染 6 欄讀書計畫表格
        renderStudyPlanTable(allTasks, reviewsByWeek);

        // 同步下方 Mentor 階段選擇器
        var validStageWeeks = stages.map(function (s) { return s.week; });
        if (validStageWeeks.indexOf(selectedReviewWeek) === -1) {
          selectedReviewWeek = validStageWeeks[0] || 1;
        }
        reviewStageSelect.textContent = '';
        stages.forEach(function (stObj) {
          var titleSuffix = stObj.phase ? (' — ' + stObj.phase) : '';
          var opt = h('option', { value: String(stObj.week), text: stObj.shortLabel + titleSuffix });
          if (stObj.week === selectedReviewWeek) opt.selected = true;
          reviewStageSelect.appendChild(opt);
        });

        if (!isEditingReview) {
          var activeStageObj = stages.find(function (s) { return s.week === selectedReviewWeek; }) || { week: selectedReviewWeek, shortLabel: 'Stage ' + selectedReviewWeek };
          renderWeekReview(reviewsByWeek[selectedReviewWeek], currentHire, activeStageObj);
        }
      }

      function renderStudyPlanTable(allTasks, reviewsByWeek) {
        var filtered = selectedFilter === 'all'
          ? allTasks
          : allTasks.filter(function (t) { return Number(t.data.week) === Number(selectedFilter); });

        var doneTasks = filtered.filter(function (t) { return isTaskDone(t.data.status); });
        weekProgressBadge.textContent = doneTasks.length + ' / ' + filtered.length + i18n.t(' 完成', ' Done');

        taskTableBody.textContent = '';
        if (!filtered.length) {
          tableWrap.hidden = true;
          emptyTaskState.hidden = false;
          emptyTaskState.textContent = i18n.t(
            '目前尚無讀書計畫階段項目。' + (canWrite ? '可點選上方「套用預設課綱範本」一鍵匯入 5 個階段課綱，或點選「新增讀書階段項目」自行新增！' : ''),
            'No study stages yet. ' + (canWrite ? 'Click "Apply Default Curriculum" above to import the 5 stages, or click "Add Study Stage".' : '')
          );
          return;
        }

        tableWrap.hidden = false;
        emptyTaskState.hidden = true;

        filtered.forEach(function (item) {
          var id = item.id;
          var t = item.data;
          var wk = Number(t.week) || 1;
          var stKey = TASK_STATUS_META[t.status] ? t.status : 'pending';
          var stMeta = TASK_STATUS_META[stKey];

          // 1. Timeline + 內嵌時間範圍 (Start Date ~ End Date)
          var timelineText = t.timeline || ('Week ' + wk);
          var tdTimeline = h('td', { class: 'align-top space-y-1.5' });
          tdTimeline.appendChild(h('div', { class: 'font-semibold text-xs whitespace-pre-line', text: timelineText }));

          if (canWrite) {
            var dateBox = h('div', { class: 'space-y-1 pt-0.5' });
            var endInput = h('input', {
              type: 'date',
              class: 'input input-bordered input-xs w-full text-xs',
              value: t.endDate || '',
              title: i18n.t('結束日期（修改後自動遞推後續週期）', 'End Date (auto-cascades following weeks)'),
              onchange: function (ev) {
                var newEnd = ev.target.value || '';
                var ops = [sync.save(COL_TASKS, id, { endDate: newEnd, updatedAt: Date.now() })];
                if (newEnd) {
                  ops = ops.concat(buildCascadedTaskDateUpdates(selectedHireId, wk, newEnd));
                }
                run(Promise.all(ops));
              }
            });
            var startInput = h('input', {
              type: 'date',
              class: 'input input-bordered input-xs w-full text-xs',
              value: t.startDate || '',
              title: i18n.t('開始日期（選擇後自動帶入本週結束日並遞推後續週期）', 'Start Date (auto-fills End Date & cascades following weeks)'),
              onchange: function (ev) {
                var newStart = ev.target.value || '';
                var autoEnd = newStart ? calcDefaultWorkEndDate(newStart) : (endInput.value || '');
                if (autoEnd) endInput.value = autoEnd;
                var ops = [sync.save(COL_TASKS, id, { startDate: newStart, endDate: autoEnd, updatedAt: Date.now() })];
                if (autoEnd) {
                  ops = ops.concat(buildCascadedTaskDateUpdates(selectedHireId, wk, autoEnd));
                }
                run(Promise.all(ops));
              }
            });
            dateBox.appendChild(h('div', { class: 'flex items-center gap-1 text-[11px] text-base-content/60' },
              h('span', { class: 'w-7 shrink-0', text: i18n.t('起', 'From') }),
              startInput
            ));
            dateBox.appendChild(h('div', { class: 'flex items-center gap-1 text-[11px] text-base-content/60' },
              h('span', { class: 'w-7 shrink-0', text: i18n.t('迄', 'To') }),
              endInput
            ));
            tdTimeline.appendChild(dateBox);
          } else if (t.startDate || t.endDate) {
            var rangeStr = (t.startDate || '?') + ' ~ ' + (t.endDate || '?');
            tdTimeline.appendChild(h('div', { class: 'badge badge-ghost badge-xs font-normal', text: rangeStr }));
          }

          // 2. Phase / Domain
          var phaseText = t.phase || t.title || i18n.t('未命名階段', 'Untitled Stage');
          var tdPhase = h('td', { class: 'font-semibold text-sm align-top' }, phaseText);

          // 3. Key Topics & Hands-on Tasks
          var topicsText = t.keyTopics || t.traineeNote || '';
          var tdTopics = h('td', { class: 'text-xs leading-relaxed whitespace-pre-wrap align-top' }, topicsText);

          // 4. Resources & Format
          var tdResources = h('td', { class: 'text-xs align-top space-y-1' });
          if (t.resources) {
            tdResources.appendChild(h('div', { class: 'whitespace-pre-wrap', text: t.resources }));
          }
          var validHref = safeUrl(t.resourceUrl);
          if (validHref) {
            tdResources.appendChild(
              h('a', {
                href: validHref,
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'link link-primary inline-flex items-center gap-1'
              },
                h('i', { class: 'fa-solid fa-arrow-up-right-from-square', 'aria-hidden': 'true' }),
                i18n.t('開啟連結', 'Open Link')
              )
            );
          }
          if (!t.resources && !validHref) {
            tdResources.appendChild(h('span', { class: 'text-base-content/40', text: '-' }));
          }

          // 5. Remarks / Milestones
          var remarksText = t.remarks !== undefined ? t.remarks : '';
          var tdRemarks = h('td', { class: 'text-xs whitespace-pre-wrap align-top text-base-content/80' }, remarksText || '-');

          // 6. Status + 操作
          var tdStatus = h('td', { class: 'align-top text-center space-y-1.5' });
          var statusBtn = h('button', {
            type: 'button',
            class: 'badge badge-sm whitespace-nowrap ' + stMeta.badge + (canWrite ? ' cursor-pointer hover:opacity-80' : ''),
            title: canWrite ? i18n.t('點擊快速切換完成狀態 (Completed / Pending)', 'Click to toggle status (Completed / Pending)') : '',
            onclick: function () {
              if (!canWrite) return;
              run(sync.save(COL_TASKS, id, { status: stMeta.next, updatedAt: Date.now() }));
            }
          }, stMeta.label);
          tdStatus.appendChild(h('div', {}, statusBtn));

          // 顯示該階段是否已有 Mentor Checkpoint 評估
          var wkRev = reviewsByWeek[wk];
          if (wkRev && EVAL_META[wkRev.data.status]) {
            var evalBtn = h('button', {
              type: 'button',
              class: 'btn btn-ghost btn-xs text-xs gap-1',
              title: i18n.t('點此查看下方 Mentor 評估', 'Click to view Mentor checkpoint below'),
              onclick: function () {
                selectedReviewWeek = wk;
                isEditingReview = false;
                renderAll();
                weekReviewTitle.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            },
              h('i', { class: 'fa-solid ' + EVAL_META[wkRev.data.status].icon, 'aria-hidden': 'true' }),
              i18n.t('Mentor 已評', 'Evaluated')
            );
            tdStatus.appendChild(h('div', {}, evalBtn));
          }

          if (canWrite) {
            var editLbl = i18n.t('編輯階段項目', 'Edit Stage');
            var delLbl = i18n.t('刪除階段項目', 'Delete Stage');
            var rowActions = h('div', { class: 'flex items-center justify-center gap-1 pt-0.5' },
              h('button', {
                type: 'button',
                class: 'btn btn-ghost btn-xs btn-square',
                'aria-label': editLbl,
                title: editLbl,
                onclick: function () { openTaskModal(id, t); }
              }, h('i', { class: 'fa-regular fa-pen-to-square', 'aria-hidden': 'true' })),
              h('button', {
                type: 'button',
                class: 'btn btn-ghost btn-xs btn-square text-base-content/60 hover:text-error',
                'aria-label': delLbl,
                title: delLbl,
                onclick: function () {
                  askConfirm(
                    i18n.t('確定要刪除「' + phaseText + '」嗎？', 'Delete stage "' + phaseText + '"?'),
                    function () { run(sync.remove(COL_TASKS, id)); },
                    { danger: true }
                  );
                }
              }, h('i', { class: 'fa-regular fa-trash-can', 'aria-hidden': 'true' }))
            );
            tdStatus.appendChild(rowActions);
          }

          var tr = h('tr', { class: 'hover:bg-base-200/40' }, tdTimeline, tdPhase, tdTopics, tdResources, tdRemarks, tdStatus);
          taskTableBody.appendChild(tr);
        });
      }

      function renderWeekReview(reviewEntry, currentHire, stageObj) {
        reviewCurrentBadge.textContent = '';
        reviewDisplay.textContent = '';
        reviewForm.hidden = true;
        reviewDisplay.hidden = false;
        editReviewBtn.hidden = !canWrite;

        var stageTitle = stageObj.shortLabel + (stageObj.phase ? (' (' + stageObj.phase + ')') : '');

        if (!reviewEntry) {
          reviewDisplay.appendChild(
            h('div', { class: 'text-sm text-base-content/60 py-4 text-center bg-base-200/40 rounded-box' },
              i18n.t(
                '「' + stageTitle + '」尚未填寫 Mentor 進度評估。' + (canWrite ? '請點選右方「填寫 / 更新本階段評估」進行記錄。' : ''),
                'No Mentor checkpoint recorded for "' + stageTitle + '" yet. ' + (canWrite ? 'Click "Write / Update Evaluation" on the right to add one.' : '')
              )
            )
          );
          return;
        }

        var rev = reviewEntry.data;
        reviewCurrentBadge.appendChild(makeEvalBadge(rev.status));

        var grid = h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1' },
          h('div', { class: 'p-3 rounded-box bg-base-200/50 space-y-1' },
            h('div', { class: 'text-xs font-semibold text-base-content/60', text: i18n.t('Mentor 週評語與回饋 (Feedback & Action Items)', 'Mentor Feedback & Action Items') }),
            h('div', { class: 'text-sm whitespace-pre-wrap', text: rev.mentorComment || i18n.t('（無評語）', '(No comments)') })
          ),
          h('div', { class: 'p-3 rounded-box bg-base-200/50 space-y-1' },
            h('div', { class: 'text-xs font-semibold text-base-content/60', text: i18n.t('學員本階段心得與提問 (Learner Reflection)', 'Learner Reflection & Questions') }),
            h('div', { class: 'text-sm whitespace-pre-wrap', text: rev.traineeSummary || i18n.t('（尚無填寫心得）', '(No reflection yet)') })
          )
        );
        reviewDisplay.appendChild(grid);

        var footerText = i18n.t('評估人：', 'Reviewed by: ') + (rev.mentorName || currentHire.mentor || '-') +
          (rev.updatedAt ? ' · ' + i18n.t('更新時間：', 'Updated: ') + new Date(rev.updatedAt).toLocaleString(i18n.lang === 'en' ? 'en-US' : 'zh-TW') : '');
        reviewDisplay.appendChild(h('div', { class: 'text-xs text-base-content/60 text-right pt-1', text: footerText }));
      }

      function openTplForm(tplId, tplData) {
        editingTplId = tplId || null;
        tplFormTitle.textContent = editingTplId
          ? i18n.t('編輯範本階段', 'Edit Template Stage')
          : i18n.t('新增範本階段', 'Add Template Stage');
        var list = getSortedTemplates();
        var nextWk = list.length + 1;
        var wk = (tplData && (tplData.week || tplData.order)) || nextWk;
        tplWeekInput.value = wk;
        tplTimelineInput.value = (tplData && tplData.timeline) || ('Week ' + wk);
        tplStatusInput.value = (tplData && TASK_STATUS_META[tplData.defaultStatus] ? tplData.defaultStatus : 'pending');
        tplPhaseInput.value = (tplData && tplData.phase) || '';
        tplTopicsInput.value = (tplData && tplData.keyTopics) || '';
        tplResourcesInput.value = (tplData && tplData.resources) || '';
        tplResourceUrlInput.value = (tplData && tplData.resourceUrl) || '';
        tplRemarksInput.value = (tplData && tplData.remarks) || '';
        tplItemForm.hidden = false;
        tplPhaseInput.focus();
      }

      function renderTemplateModalList() {
        if (!tplTableBody) return;
        tplTableBody.textContent = '';
        var list = getSortedTemplates();
        if (!list.length) {
          tplTableBody.appendChild(
            h('tr', {},
              h('td', { colspan: '7', class: 'text-center py-6 text-base-content/60' },
                i18n.t('目前沒有任何範本階段，請點選右上角「新增範本階段」建立。', 'No template stages yet. Click "Add Template Stage" above.')
              )
            )
          );
          return;
        }
        list.forEach(function (tpl) {
          var id = tpl._id;
          var wk = Number(tpl.week) || Number(tpl.order) || 1;
          var tr = h('tr', { class: 'hover:bg-base-200/40' },
            h('td', { class: 'font-semibold align-top', text: String(wk) }),
            h('td', { class: 'whitespace-pre-line align-top font-medium', text: tpl.timeline || ('Week ' + wk) }),
            h('td', { class: 'align-top font-semibold', text: tpl.phase || '' }),
            h('td', { class: 'whitespace-pre-wrap align-top text-base-content/80', text: tpl.keyTopics || '' }),
            h('td', { class: 'whitespace-pre-wrap align-top text-base-content/80', text: tpl.resources || '-' }),
            h('td', { class: 'whitespace-pre-wrap align-top text-base-content/80', text: tpl.remarks || '-' }),
            h('td', { class: 'align-top text-center' },
              h('div', { class: 'flex items-center justify-center gap-1' },
                h('button', {
                  type: 'button',
                  class: 'btn btn-ghost btn-xs btn-square',
                  title: i18n.t('編輯此範本階段', 'Edit template stage'),
                  onclick: function () { openTplForm(id, tpl); }
                }, h('i', { class: 'fa-regular fa-pen-to-square', 'aria-hidden': 'true' })),
                h('button', {
                  type: 'button',
                  class: 'btn btn-ghost btn-xs btn-square text-base-content/60 hover:text-error',
                  title: i18n.t('刪除此範本階段', 'Delete template stage'),
                  onclick: function () {
                    askConfirm(
                      i18n.t('確定要從預設課綱範本刪除「' + (tpl.phase || '') + '」嗎？', 'Remove "' + (tpl.phase || '') + '" from default curriculum template?'),
                      function () { run(sync.remove(COL_TEMPLATES, id)); },
                      { danger: true }
                    );
                  }
                }, h('i', { class: 'fa-regular fa-trash-can', 'aria-hidden': 'true' }))
              )
            )
          );
          tplTableBody.appendChild(tr);
        });
      }
      function openHireModal(hireId, hireData) {
        editingHireId = hireId || null;
        hireModalTitle.textContent = editingHireId
          ? i18n.t('編輯學員資料', 'Edit Learner')
          : i18n.t('新增學員', 'Add Learner');
        hireNameInput.value = (hireData && hireData.name) || '';
        hireMentorInput.value = (hireData && hireData.mentor) || (ctx.session && ctx.session.name) || '';
        hireRoleInput.value = (hireData && hireData.roleTitle) || '';
        hireDateInput.value = (hireData && hireData.startDate) || new Date().toISOString().slice(0, 10);
        hireSeedWrap.hidden = !!editingHireId;
        hireSeedCheckbox.checked = !editingHireId;
        hireModal.showModal();
      }

      function openTaskModal(taskId, taskData) {
        editingTaskId = taskId || null;
        taskModalTitle.textContent = editingTaskId
          ? i18n.t('編輯讀書週期 / 階段', 'Edit Cycle / Stage')
          : i18n.t('新增讀書週期 / 階段', 'Add Cycle / Stage');
        var allTasks = getHireTasks(selectedHireId);
        var maxW = 0;
        allTasks.forEach(function (item) {
          var w = Number(item.data.week) || 1;
          if (w > maxW) maxW = w;
        });
        var defaultWk = selectedFilter === 'all' ? (maxW + 1) : Number(selectedFilter);
        var wkVal = (taskData && taskData.week) || defaultWk;
        var autoRange = calcDefaultRangeForTargetWeek(selectedHireId, wkVal);

        taskWeekInput.value = wkVal;
        taskTimelineInput.value = (taskData && taskData.timeline) || ('Week ' + wkVal);
        taskStartDateInput.value = (taskData && taskData.startDate) ? taskData.startDate : autoRange.startDate;
        taskEndDateInput.value = (taskData && taskData.endDate) ? taskData.endDate : autoRange.endDate;
        taskStatusInput.value = (taskData && TASK_STATUS_META[taskData.status] ? taskData.status : 'pending');
        taskTitleInput.value = (taskData && (taskData.phase || taskData.title)) || '';
        taskTopicsInput.value = (taskData && (taskData.keyTopics || taskData.traineeNote)) || '';
        taskResourceTextInput.value = (taskData && taskData.resources) || '';
        taskResourceInput.value = (taskData && taskData.resourceUrl) || '';
        taskNoteInput.value = (taskData && taskData.remarks) || '';
        taskModal.showModal();
      }

      if (canWrite) {
        addHireBtn.hidden = false;
        manageTemplateBtn.hidden = false;
        addTaskBtn.hidden = false;

        addHireBtn.addEventListener('click', function () {
          openHireModal(null, null);
        });

        applyTemplateBtn.addEventListener('click', function () {
          if (!selectedHireId || !hiresMap[selectedHireId]) return;
          var existingCount = getHireTasks(selectedHireId).length;
          var existingRevCount = Object.keys(getHireReviews(selectedHireId)).length;
          var msg = (existingCount > 0 || existingRevCount > 0)
            ? i18n.t(
                '確定要「套用預設課綱範本並覆蓋當下資料」嗎？\n（目前共 ' + existingCount + ' 筆讀書階段與 ' + existingRevCount + ' 筆 Mentor 階段進度評估將一併重置）',
                'Apply default curriculum template and OVERWRITE current data?\n(' + existingCount + ' stage(s) and ' + existingRevCount + ' Mentor checkpoint(s) will be reset)'
              )
            : i18n.t(
                '確定要套用預設課綱範本並重置 Mentor 階段進度評估嗎？',
                'Apply default curriculum template and reset Mentor stage checkpoints?'
              );
          askConfirm(
            msg,
            function () {
              selectedFilter = 'all';
              selectedReviewWeek = 1;
              isEditingReview = false;
              run(applyCurriculumTemplateToHire(selectedHireId, null, true));
            },
            { okLabel: i18n.t('套用並重置', 'Apply & Reset') }
          );
        });

        manageTemplateBtn.addEventListener('click', function () {
          tplItemForm.hidden = true;
          editingTplId = null;
          renderTemplateModalList();
          tplListModal.showModal();
        });

        tplListCloseBtn.addEventListener('click', function () {
          tplListModal.close();
        });

        [applyTplSelect, hireTplSelect, tplSetSelect].forEach(function (sel) {
          sel.addEventListener('change', function () { setSelectedTplSet(sel.value); });
        });

        tplNewSetBtn.addEventListener('click', function () {
          var name = tplNewSetInput.value.trim().slice(0, 60);
          if (!name) return;
          var exists = getTemplateSetNames().filter(function (n) { return n.toLowerCase() === name.toLowerCase(); })[0];
          if (!exists) localTplSets.push(name);
          tplNewSetInput.value = '';
          setSelectedTplSet(exists || name);
        });

        tplDeleteSetBtn.addEventListener('click', function () {
          var setName = selectedTplSet;
          var stages = getSortedTemplates();
          askConfirm(
            i18n.t('確定要刪除整套範本「' + setName + '」（' + stages.length + ' 個階段）嗎？', 'Delete the whole template "' + setName + '" (' + stages.length + ' stage(s))?'),
            function () {
              localTplSets = localTplSets.filter(function (n) { return n !== setName; });
              run(Promise.all(stages.map(function (t) { return sync.remove(COL_TEMPLATES, t._id); })));
            },
            { danger: true }
          );
        });

        tplImportCsvBtn.addEventListener('click', function () {
          tplImportCsvInput.click();
        });

        tplImportCsvInput.addEventListener('change', function () {
          var file = tplImportCsvInput.files && tplImportCsvInput.files[0];
          tplImportCsvInput.value = '';
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function () {
            var stages = csvToTemplateStages(String(reader.result || ''));
            if (!stages.length) {
              showErr(new Error(i18n.t('CSV 內容無法辨識（需包含 Category、Title 欄位）', 'Unrecognized CSV (needs Category and Title columns)')));
              return;
            }
            var setName = selectedTplSet;
            var old = getSortedTemplates();
            askConfirm(
              i18n.t(
                '將匯入 ' + stages.length + ' 個階段到範本「' + setName + '」' + (old.length ? '，並覆蓋該範本現有的 ' + old.length + ' 個階段' : '') + '。確定嗎？',
                'Import ' + stages.length + ' stage(s) into template "' + setName + '"' + (old.length ? ', replacing its ' + old.length + ' existing stage(s)' : '') + '. Continue?'
              ),
              function () {
                var now = Date.now();
                run(
                  Promise.all(old.map(function (t) { return sync.remove(COL_TEMPLATES, t._id); })).then(function () {
                    return Promise.all(stages.map(function (s, idx) {
                      return sync.save(COL_TEMPLATES, 'tpl_w' + (idx + 1) + '_' + sync.newId(), {
                        setName: setName,
                        order: idx + 1,
                        week: idx + 1,
                        timeline: 'Week ' + (idx + 1),
                        phase: s.phase,
                        keyTopics: s.keyTopics,
                        resources: '',
                        resourceUrl: '',
                        remarks: '',
                        defaultStatus: 'pending',
                        updatedAt: now
                      });
                    }));
                  })
                );
              },
              { okLabel: i18n.t('匯入', 'Import') }
            );
          };
          reader.readAsText(file, 'utf-8');
        });

        addTplItemBtn.addEventListener('click', function () {
          openTplForm(null, null);
        });

        tplFormCancelBtn.addEventListener('click', function () {
          tplItemForm.hidden = true;
          editingTplId = null;
        });

        tplItemForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var wk = Math.max(1, Math.min(52, Number(tplWeekInput.value) || 1));
          var timeline = tplTimelineInput.value.trim().slice(0, 120);
          var defaultStatus = tplStatusInput.value || 'pending';
          var phase = tplPhaseInput.value.trim().slice(0, 200);
          var keyTopics = tplTopicsInput.value.trim().slice(0, 8000);
          var resources = tplResourcesInput.value.trim().slice(0, 500);
          var resourceUrl = tplResourceUrlInput.value.trim().slice(0, 500);
          var remarks = tplRemarksInput.value.trim().slice(0, 2000);
          if (!phase || !timeline) return;

          var id = editingTplId || ('tpl_' + sync.newId());
          var payload = {
            setName: selectedTplSet,
            order: wk,
            week: wk,
            timeline: timeline,
            phase: phase,
            keyTopics: keyTopics,
            resources: resources,
            resourceUrl: resourceUrl,
            remarks: remarks,
            defaultStatus: defaultStatus,
            updatedAt: Date.now()
          };
          tplItemForm.hidden = true;
          editingTplId = null;
          run(sync.save(COL_TEMPLATES, id, payload));
        });

        saveCurrentAsTplBtn.addEventListener('click', function () {
          if (!selectedHireId) return;
          var currentTasks = getHireTasks(selectedHireId);
          if (!currentTasks.length) {
            showErr(new Error(i18n.t('目前選定的學員尚無任何課綱階段可存為範本。', 'Current learner has no study stages to save as template.')));
            return;
          }
          var confirmMsg = i18n.t(
            '確定要將目前學員的 ' + currentTasks.length + ' 個階段覆蓋儲存為新的「預設課綱範本」嗎？',
            'Overwrite the default curriculum template with the ' + currentTasks.length + ' stages from the current learner?'
          );
          askConfirm(confirmMsg, function () {
            var removeOps = getSortedTemplates().map(function (t) {
              return sync.remove(COL_TEMPLATES, t._id);
            });
            run(
              Promise.all(removeOps).then(function () {
                var saveOps = currentTasks.map(function (item, idx) {
                  var t = item.data;
                  var wk = Number(t.week) || (idx + 1);
                  return sync.save(COL_TEMPLATES, 'tpl_w' + (idx + 1) + '_' + sync.newId(), {
                    setName: selectedTplSet,
                    order: wk,
                    week: wk,
                    timeline: t.timeline || ('Week ' + wk),
                    phase: t.phase || t.title || '',
                    keyTopics: t.keyTopics || t.traineeNote || '',
                    resources: t.resources || '',
                    resourceUrl: t.resourceUrl || '',
                    remarks: t.remarks || '',
                    defaultStatus: t.status === 'final_eval' ? 'final_eval' : 'pending',
                    updatedAt: Date.now()
                  });
                });
                return Promise.all(saveOps);
              })
            );
          });
        });

        editHireBtn.addEventListener('click', function () {
          if (!selectedHireId || !hiresMap[selectedHireId]) return;
          openHireModal(selectedHireId, hiresMap[selectedHireId]);
        });

        deleteHireBtn.addEventListener('click', function () {
          if (!selectedHireId || !hiresMap[selectedHireId]) return;
          var hr = hiresMap[selectedHireId];
          askConfirm(
            i18n.t('確定要刪除學員「' + (hr.name || '') + '」及其所有讀書計畫與評估紀錄嗎？', 'Delete learner "' + (hr.name || '') + '" and all their study stages and evaluations?'),
            function () {
              var targetHireId = selectedHireId;
              var promises = [sync.remove(COL_HIRES, targetHireId)];
              getHireTasks(targetHireId).forEach(function (t) {
                promises.push(sync.remove(COL_TASKS, t.id));
              });
              var revs = getHireReviews(targetHireId);
              Object.keys(revs).forEach(function (w) {
                promises.push(sync.remove(COL_REVIEWS, revs[w].id));
              });
              selectedHireId = '';
              saveSelectedHirePref('');
              run(Promise.all(promises));
            },
            { danger: true }
          );
        });

        hireModalCancel.addEventListener('click', function () {
          hireModal.close();
        });

        hireForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var name = hireNameInput.value.trim().slice(0, 100);
          var mentor = hireMentorInput.value.trim().slice(0, 100);
          var roleTitle = hireRoleInput.value.trim().slice(0, 100);
          var startDate = hireDateInput.value.trim().slice(0, 30);
          if (!name) return;

          var isNew = !editingHireId;
          var shouldSeed = isNew && hireSeedCheckbox.checked;
          var id = editingHireId || sync.newId();
          var payload = {
            name: name,
            mentor: mentor,
            roleTitle: roleTitle,
            startDate: startDate,
            updatedAt: Date.now()
          };
          if (isNew) {
            payload.createdAt = Date.now();
            selectedHireId = id;
            saveSelectedHirePref(id);
          }
          hireModal.close();
          run(
            sync.save(COL_HIRES, id, payload).then(function () {
              if (shouldSeed) {
                return applyCurriculumTemplateToHire(id, startDate);
              }
            })
          );
        });

        quickAddCycleBtn.addEventListener('click', function () {
          if (!selectedHireId) return;
          var savedFilter = selectedFilter;
          selectedFilter = 'all';
          openTaskModal(null, null);
          selectedFilter = savedFilter;
        });

        deleteCycleBtn.addEventListener('click', function () {
          if (!selectedHireId || selectedFilter === 'all') return;
          var targetWk = Number(selectedFilter);
          var wkTasks = getHireTasks(selectedHireId).filter(function (t) { return Number(t.data.week) === targetWk; });
          var revs = getHireReviews(selectedHireId);
          var wkRev = revs[targetWk];
          var confirmMsg = i18n.t(
            '確定要刪除整個週期（Stage / Week ' + targetWk + '，共 ' + wkTasks.length + ' 筆項目）及其 Mentor 評估紀錄嗎？',
            'Delete entire cycle (Stage / Week ' + targetWk + ', ' + wkTasks.length + ' items) and its Mentor evaluation?'
          );
          askConfirm(confirmMsg, function () {
            var promises = wkTasks.map(function (t) { return sync.remove(COL_TASKS, t.id); });
            if (wkRev) promises.push(sync.remove(COL_REVIEWS, wkRev.id));
            selectedFilter = 'all';
            run(Promise.all(promises));
          }, { danger: true });
        });

        autoDateBtn.addEventListener('click', function () {
          if (!selectedHireId || !hiresMap[selectedHireId]) return;
          var hr = hiresMap[selectedHireId];
          function applyBatchDates(baseDate) {
            var allTasks = getHireTasks(selectedHireId);
            var promises = allTasks.map(function (item) {
              var wk = Number(item.data.week) || 1;
              var r = calcWeekRangeFromHireStart(baseDate, wk);
              return sync.save(COL_TASKS, item.id, {
                startDate: r.startDate,
                endDate: r.endDate,
                updatedAt: Date.now()
              });
            });
            run(Promise.all(promises));
          }
          if (hr.startDate) {
            applyBatchDates(hr.startDate);
          } else {
            askConfirm(
              i18n.t('請選擇學員的開始日（系統將以此自動推算各週期 5 個工作日範圍）：', 'Select start date to auto-calculate weekly 5-workday ranges:'),
              function (pickedDate) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(pickedDate)) return;
                run(sync.save(COL_HIRES, selectedHireId, { startDate: pickedDate, updatedAt: Date.now() }));
                applyBatchDates(pickedDate);
              },
              { promptDate: true }
            );
          }
        });

        addTaskBtn.addEventListener('click', function () {
          if (!selectedHireId) return;
          openTaskModal(null, null);
        });

        function syncModalWorkEndDate() {
          var sVal = taskStartDateInput.value;
          if (!sVal) return;
          var autoEnd = calcDefaultWorkEndDate(sVal);
          if (autoEnd) taskEndDateInput.value = autoEnd;
        }
        taskStartDateInput.addEventListener('change', syncModalWorkEndDate);
        taskStartDateInput.addEventListener('input', syncModalWorkEndDate);

        // 當在新增視窗改變「週期順序 (Week N)」時，自動根據上一週延伸計算預設起訖日
        taskWeekInput.addEventListener('change', function () {
          if (editingTaskId || !selectedHireId) return;
          var wk = Math.max(1, Math.min(52, Number(taskWeekInput.value) || 1));
          var r = calcDefaultRangeForTargetWeek(selectedHireId, wk);
          if (r.startDate) taskStartDateInput.value = r.startDate;
          if (r.endDate) taskEndDateInput.value = r.endDate;
          if (/^Week\s+\d+$/i.test(taskTimelineInput.value.trim())) {
            taskTimelineInput.value = 'Week ' + wk;
          }
        });

        taskModalCancel.addEventListener('click', function () {
          taskModal.close();
        });

        taskForm.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!selectedHireId) return;
          var wk = Math.max(1, Math.min(52, Number(taskWeekInput.value) || 1));
          var timeline = taskTimelineInput.value.trim().slice(0, 120);
          var startDate = taskStartDateInput.value.trim().slice(0, 30);
          var endDate = taskEndDateInput.value.trim().slice(0, 30);
          if (startDate && !endDate) {
            endDate = calcDefaultWorkEndDate(startDate);
          }
          var st = taskStatusInput.value || 'pending';
          var phase = taskTitleInput.value.trim().slice(0, 200);
          var topics = taskTopicsInput.value.trim().slice(0, 8000);
          var resources = taskResourceTextInput.value.trim().slice(0, 500);
          var resUrl = taskResourceInput.value.trim().slice(0, 500);
          var remarks = taskNoteInput.value.trim().slice(0, 2000);
          if (!phase || !timeline) return;

          var id = editingTaskId || sync.newId();
          var payload = {
            hireId: selectedHireId,
            week: wk,
            timeline: timeline,
            startDate: startDate,
            endDate: endDate,
            phase: phase,
            title: phase,
            keyTopics: topics,
            resources: resources,
            resourceUrl: resUrl,
            remarks: remarks,
            status: st,
            updatedAt: Date.now(),
            updatedBy: (ctx.session && ctx.session.name) || ''
          };
          if (!editingTaskId) {
            payload.createdAt = Date.now();
          }
          taskModal.close();
          var ops = [sync.save(COL_TASKS, id, payload)];
          if (endDate) {
            ops = ops.concat(buildCascadedTaskDateUpdates(selectedHireId, wk, endDate));
          }
          run(Promise.all(ops));
        });

        editReviewBtn.addEventListener('click', function () {
          if (!selectedHireId) return;
          var revs = getHireReviews(selectedHireId);
          var curr = revs[selectedReviewWeek] ? revs[selectedReviewWeek].data : null;
          var hr = hiresMap[selectedHireId] || {};
          isEditingReview = true;
          reviewStatusInput.value = (curr && curr.status) || 'on_track';
          reviewMentorInput.value = (curr && curr.mentorName) || hr.mentor || (ctx.session && ctx.session.name) || '';
          reviewCommentInput.value = (curr && curr.mentorComment) || '';
          reviewSummaryInput.value = (curr && curr.traineeSummary) || '';
          reviewDisplay.hidden = true;
          reviewForm.hidden = false;
          editReviewBtn.hidden = true;
        });

        cancelReviewBtn.addEventListener('click', function () {
          isEditingReview = false;
          renderAll();
        });

        reviewForm.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!selectedHireId) return;
          var revs = getHireReviews(selectedHireId);
          var existing = revs[selectedReviewWeek];
          var id = existing ? existing.id : (selectedHireId + '_w' + selectedReviewWeek);
          var payload = {
            hireId: selectedHireId,
            week: selectedReviewWeek,
            status: reviewStatusInput.value || 'on_track',
            mentorName: reviewMentorInput.value.trim().slice(0, 100),
            mentorComment: reviewCommentInput.value.trim().slice(0, 3000),
            traineeSummary: reviewSummaryInput.value.trim().slice(0, 3000),
            updatedAt: Date.now(),
            updatedBy: (ctx.session && ctx.session.name) || ''
          };
          isEditingReview = false;
          run(sync.save(COL_REVIEWS, id, payload));
        });
      }

      hireSelect.addEventListener('change', function () {
        selectedHireId = hireSelect.value;
        saveSelectedHirePref(selectedHireId);
        selectedFilter = 'all';
        selectedReviewWeek = 1;
        isEditingReview = false;
        renderAll();
      });

      reviewStageSelect.addEventListener('change', function () {
        selectedReviewWeek = Number(reviewStageSelect.value) || 1;
        isEditingReview = false;
        renderAll();
      });

      refreshBtn.addEventListener('click', function () {
        subHires.refresh();
        subTasks.refresh();
        subReviews.refresh();
        subTemplates.refresh();
      });

      i18n.onChange(function () {
        renderAll();
      });

      var subHires = sync.subscribe(COL_HIRES, {
        onChange: function (map) { hiresMap = map || {}; renderAll(); },
        onError: showErr,
        onStatus: function (s) { curSyncStatus = s; statusEl.textContent = getStatusLabel(s); }
      });

      var subTasks = sync.subscribe(COL_TASKS, {
        onChange: function (map) { tasksMap = map || {}; renderAll(); },
        onError: showErr,
        onStatus: function () {}
      });

      var subReviews = sync.subscribe(COL_REVIEWS, {
        onChange: function (map) { reviewsMap = map || {}; renderAll(); },
        onError: showErr,
        onStatus: function () {}
      });

      var subTemplates = sync.subscribe(COL_TEMPLATES, {
        onChange: function (map) {
          templatesMap = map || {};
          renderTplSetSelects();
          renderTemplateModalList();
          renderAll();
        },
        onError: showErr,
        onStatus: function () {}
      });
    }
  };
})();



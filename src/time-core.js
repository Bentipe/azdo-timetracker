/* ================================================================
   time-core.js — shared storage + entry logic

   Loaded as a plain <script> (no build step), exposes window.TimeCore.
   The entry shape and inheritance chain here MUST stay identical to
   what time-entry.html writes, so entries created from the My Time
   hub look the same in Time Reports as ones created from the form.
   ================================================================ */
(function (global) {
  "use strict";

  var STORAGE_KEY_PREFIX = "timetracker_";

  // Possible field reference names (vary by where the field was created
  // in Azure DevOps). Kept in sync with time-entry.html.
  var CLIENT_FIELD_REFS = ["Custom.Client", "Custom.Planning_Client", "Planning.Client"];
  var PROJECT_FIELD_REFS = ["Custom.Project", "Custom.Planning_Project", "Planning.Project"];

  function getFieldValue(fields, refNames, defaultValue) {
    for (var i = 0; i < refNames.length; i++) {
      if (fields[refNames[i]]) return fields[refNames[i]];
    }
    return defaultValue;
  }

  // ---- Date helpers ------------------------------------------------
  // Entries store `date` as a local YYYY-MM-DD string (the value of an
  // <input type="date">). All comparisons are string-based to dodge the
  // timezone drift a `new Date(str)` round-trip would introduce.

  function pad2(n) { return String(n).padStart(2, "0"); }

  function localISODate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function todayISO() {
    return localISODate(new Date());
  }

  // Monday as the first day of the week. Returns a Date at local midnight.
  function startOfWeek(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var day = x.getDay();              // 0=Sun .. 6=Sat
    var diff = day === 0 ? -6 : 1 - day;
    x.setDate(x.getDate() + diff);
    return x;
  }

  // ISO strings Mon..Sun for the week containing `ref` (default: today).
  function weekDates(ref) {
    var start = startOfWeek(ref || new Date());
    var out = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.push(localISODate(d));
    }
    return out;
  }

  function monthKeyFromDate(d) {
    return STORAGE_KEY_PREFIX + d.getFullYear() + "_" + pad2(d.getMonth() + 1);
  }

  function getStorageKeyForDate(dateString) {
    return monthKeyFromDate(new Date(dateString));
  }

  // Keys for the current month plus the previous (count - 1) months.
  function recentMonthKeys(count) {
    var keys = [];
    var today = new Date();
    for (var i = 0; i < count; i++) {
      keys.push(monthKeyFromDate(new Date(today.getFullYear(), today.getMonth() - i, 1)));
    }
    return keys;
  }

  // Parse a date input (Date or "YYYY-MM-DD") into {y, m} using local
  // parts only — never `new Date(str)`, which would UTC-shift the month.
  function ymOf(v) {
    if (v instanceof Date) return { y: v.getFullYear(), m: v.getMonth() };
    var p = String(v).split("-");
    return { y: parseInt(p[0], 10), m: parseInt(p[1], 10) - 1 };
  }

  // Storage keys for every month spanning [startDate, endDate] inclusive.
  function monthKeysBetween(startDate, endDate) {
    var a = ymOf(startDate), b = ymOf(endDate);
    if (isNaN(a.y) || isNaN(a.m) || isNaN(b.y) || isNaN(b.m)) return [];
    var keys = [], y = a.y, m = a.m, guard = 0;
    while ((y < b.y || (y === b.y && m <= b.m)) && guard++ < 600) {
      keys.push(STORAGE_KEY_PREFIX + y + "_" + pad2(m + 1));
      m++; if (m > 11) { m = 0; y++; }
    }
    return keys;
  }

  // ---- Storage -----------------------------------------------------

  function getEntriesForMonth(dataService, key) {
    return dataService.getValue(key, { scopeType: "Default" }).then(function (data) {
      return data || [];
    }, function () {
      return [];
    });
  }

  // Load and flatten entries across the current + previous months.
  function loadEntriesForMonths(dataService, monthCount) {
    var promises = recentMonthKeys(monthCount).map(function (key) {
      return getEntriesForMonth(dataService, key);
    });
    return Promise.all(promises).then(function (results) {
      var all = [];
      results.forEach(function (m) { all = all.concat(m); });
      return all;
    });
  }

  // Load and flatten entries for an explicit list of month keys (deduped).
  function loadEntriesForKeys(dataService, keys) {
    var seen = {}, uniq = [];
    (keys || []).forEach(function (k) { if (k && !seen[k]) { seen[k] = true; uniq.push(k); } });
    return Promise.all(uniq.map(function (k) {
      return getEntriesForMonth(dataService, k);
    })).then(function (results) {
      var all = [];
      results.forEach(function (m) { all = all.concat(m); });
      return all;
    });
  }

  function saveEntry(dataService, entry) {
    var key = getStorageKeyForDate(entry.date);
    return dataService.getValue(key, { scopeType: "Default" }).then(function (data) {
      var monthEntries = data || [];
      monthEntries.push(entry);
      return dataService.setValue(key, monthEntries, { scopeType: "Default" });
    });
  }

  function deleteEntryById(dataService, entryId, entryDate) {
    var key = getStorageKeyForDate(entryDate);
    return dataService.getValue(key, { scopeType: "Default" }).then(function (data) {
      if (!data || data.length === 0) {
        throw new Error("No entries found for this month — aborting delete to prevent data loss");
      }
      var filtered = data.filter(function (e) { return e.id !== entryId; });
      return dataService.setValue(key, filtered, { scopeType: "Default" });
    });
  }

  var EDIT_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
  var DELETE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';

  function escapeHtml(text) {
    if (text == null) return "";
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function updateEntry(dataService, entryId, originalDate, updates) {
    var originalKey = getStorageKeyForDate(originalDate);
    var newKey = getStorageKeyForDate(updates.date);
    if (originalKey === newKey) {
      return dataService.getValue(originalKey, { scopeType: "Default" }).then(function(data) {
        var updated = (data || []).map(function(e) {
          if (e.id !== entryId) return e;
          return Object.assign({}, e, updates);
        });
        return dataService.setValue(originalKey, updated, { scopeType: "Default" });
      });
    }
    return Promise.all([
      dataService.getValue(originalKey, { scopeType: "Default" }),
      dataService.getValue(newKey, { scopeType: "Default" })
    ]).then(function(results) {
      var oldEntries = results[0] || [];
      var newEntries = results[1] || [];
      var entryToMove = oldEntries.find(function(e) { return e.id === entryId; });
      if (!entryToMove) throw new Error("Entry not found in original month");
      var updatedEntry = Object.assign({}, entryToMove, updates);
      return dataService.setValue(newKey, newEntries.concat([updatedEntry]), { scopeType: "Default" }).then(function() {
        return dataService.setValue(originalKey, oldEntries.filter(function(e) { return e.id !== entryId; }), { scopeType: "Default" });
      });
    });
  }

  // ---- Entry construction with parent/epic inheritance -------------
  // Mirrors processWorkItem() in time-entry.html. Resolves with the
  // built entry; the caller is responsible for persisting it.

  function buildEntryForWorkItem(witClient, workItemId, currentUser, vals) {
    // expand: 0=None 1=Relations 2=Fields 3=Links 4=All
    return witClient.getWorkItem(workItemId, null, null, 4).then(function (workItem) {
      var entry = {
        id: Date.now().toString(),
        workItemId: workItemId,
        workItemTitle: workItem.fields["System.Title"],
        parentId: workItem.fields["System.Parent"] || null,
        tags: workItem.fields["System.Tags"] || "",
        project: getFieldValue(workItem.fields, PROJECT_FIELD_REFS, "(No Project)"),
        client: getFieldValue(workItem.fields, CLIENT_FIELD_REFS, "(No Client)"),
        hours: vals.hours,
        date: vals.date,
        description: vals.description || "",
        userId: currentUser.id,
        userName: currentUser.name,
        userEmail: currentUser.email,
        createdAt: new Date().toISOString()
      };

      var parentPromise = entry.parentId
        ? witClient.getWorkItem(entry.parentId, null, null, 4)
        : Promise.resolve(null);

      return parentPromise.then(function (parentItem) {
        if (parentItem) {
          entry.parentTitle = parentItem.fields["System.Title"];
          entry.parentType = parentItem.fields["System.WorkItemType"];

          if (!entry.tags && parentItem.fields["System.Tags"]) {
            entry.tags = parentItem.fields["System.Tags"];
            entry.tagsInheritedFrom = "parent";
          }

          var parentProject = getFieldValue(parentItem.fields, PROJECT_FIELD_REFS, null);
          if (entry.project === "(No Project)" && parentProject) {
            entry.project = parentProject;
            entry.projectInheritedFrom = "parent";
          }

          var parentClient = getFieldValue(parentItem.fields, CLIENT_FIELD_REFS, null);
          if (entry.client === "(No Client)" && parentClient) {
            entry.client = parentClient;
            entry.clientInheritedFrom = "parent";
          }

          if (parentItem.fields["System.WorkItemType"] === "Epic") {
            entry.epicId = entry.parentId;
            entry.epicTitle = entry.parentTitle;
            if (entry.project === "(No Project)" && parentProject) {
              entry.project = parentProject;
              entry.projectInheritedFrom = "epic";
            }
            if (entry.client === "(No Client)" && parentClient) {
              entry.client = parentClient;
              entry.clientInheritedFrom = "epic";
            }
            return { parentItem: parentItem, grandparentItem: null };
          }

          if (parentItem.fields["System.Parent"]) {
            return witClient.getWorkItem(parentItem.fields["System.Parent"], null, null, 4)
              .then(function (grandparentItem) {
                return { parentItem: parentItem, grandparentItem: grandparentItem };
              });
          }
        }
        return { parentItem: parentItem, grandparentItem: null };
      }).then(function (result) {
        var grandparentItem = result ? result.grandparentItem : null;

        if (grandparentItem && grandparentItem.fields["System.WorkItemType"] === "Epic") {
          entry.epicId = grandparentItem.id;
          entry.epicTitle = grandparentItem.fields["System.Title"];

          if (!entry.tags && grandparentItem.fields["System.Tags"]) {
            entry.tags = grandparentItem.fields["System.Tags"];
            entry.tagsInheritedFrom = "epic";
          }
          var gpProject = getFieldValue(grandparentItem.fields, PROJECT_FIELD_REFS, null);
          if (entry.project === "(No Project)" && gpProject) {
            entry.project = gpProject;
            entry.projectInheritedFrom = "epic";
          }
          var gpClient = getFieldValue(grandparentItem.fields, CLIENT_FIELD_REFS, null);
          if (entry.client === "(No Client)" && gpClient) {
            entry.client = gpClient;
            entry.clientInheritedFrom = "epic";
          }
        }
        return entry;
      });
    });
  }

  // ---- Add / Edit entry modal (work item picker + time entry form) ---
  // Single-screen design: the work item chip and the form fields are
  // always visible together. Clicking the chip (or the search area)
  // toggles the picker list open/closed.
  //
  // config: {
  //   dataService     — ExtensionData service
  //   witClientGetter — () => Promise<witClient>
  //   currentUser     — { id, name, email }
  //   projectName     — scopes the WIQL title search
  //   recentItems     — [{ id, title, type }] shown before the user types
  //   onSaved         — () called after a successful save
  //   title           — modal heading (default "Log Time")
  //   saveLabel       — save button label (default "Log Time")
  //   initialItem     — { id, title, type } pre-selected work item
  //   initialHours    — number
  //   initialDate     — "YYYY-MM-DD"
  //   initialDesc     — string
  //   // Edit mode (update existing entry):
  //   entryId         — id of the entry being edited
  //   originalDate    — entry.date at load time (for storage key lookup)
  // }
  function openAddEntryModal(config) {
    var old = document.getElementById('tcAddModal');
    if (old) old.remove();

    var today = localISODate(new Date());
    var backdrop = document.createElement('div');
    backdrop.id = 'tcAddModal';
    backdrop.className = 'edit-modal-backdrop';
    backdrop.style.display = 'flex';

    var PENCIL_ICON =
      '<svg class="tc-chip-pencil" width="12" height="12" viewBox="0 0 24 24" fill="none"' +
        ' stroke="currentColor" stroke-width="2.5">' +
        '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
        '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>' +
      '</svg>';

    backdrop.innerHTML =
      '<div class="edit-modal-content tc-add-modal">' +
        '<div class="tc-add-header"><h3>' + escapeHtml(config.title || 'Log Time') + '</h3>' +
          '<button class="tc-modal-close" id="tcAddClose" title="Close">&#x2715;</button></div>' +
        // Work item area: chip (selected) XOR search (unselected)
        '<button class="tc-selected-chip" id="tcSelectedChip" style="display:none"' +
          ' title="Click to change work item">' +
          '<span id="tcChipContent"></span>' +
          PENCIL_ICON +
        '</button>' +
        '<div id="tcSearchWrap">' +
          '<input type="text" id="tcSearchInput" class="tc-search-input"' +
            ' placeholder="Search by title or work item #ID…" autocomplete="off">' +
          '<div id="tcSearchStatus" class="tc-search-status"></div>' +
          '<div id="tcItemList" class="tc-item-list"></div>' +
        '</div>' +
        // Form fields — always visible
        '<div class="filter-group" style="margin-top:8px">' +
          '<label for="tcHours">Hours Spent</label>' +
          '<input type="number" id="tcHours" min="0.25" max="24" step="0.25" placeholder="e.g. 2.5"' +
            ' onkeydown="return event.key!==\'e\'&&event.key!==\'E\'&&event.key!==\'+\'&&event.key!==\'-\'">' +
        '</div>' +
        '<div class="filter-group">' +
          '<label for="tcDate">Date</label>' +
          '<input type="date" id="tcDate" value="' + today + '">' +
        '</div>' +
        '<div class="filter-group">' +
          '<label for="tcDesc">Description' +
            ' <span style="font-weight:400;color:var(--text-secondary)">(optional, max 100 chars)</span></label>' +
          '<textarea id="tcDesc" rows="2" maxlength="100"' +
            ' style="resize:vertical;width:100%;box-sizing:border-box;"></textarea>' +
        '</div>' +
        '<div id="tcFormMsg" class="message" style="display:none;margin:0;padding:6px 10px;font-size:13px;"></div>' +
        '<div class="edit-modal-actions">' +
          '<button id="tcSaveBtn">' + escapeHtml(config.saveLabel || 'Log Time') + '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(backdrop);

    var selectedItem = null;
    var searchTimer  = null;

    function close() { backdrop.remove(); document.removeEventListener('keydown', onEsc); }

    // Show the search input + list, hide the chip
    function openSearch() {
      selectedItem = null;
      document.getElementById('tcSelectedChip').style.display = 'none';
      document.getElementById('tcSearchWrap').style.display = '';
      document.getElementById('tcSearchInput').value = '';
      document.getElementById('tcSearchStatus').textContent = '';
      renderList(config.recentItems || [], 'Recently used');
      setTimeout(function() { document.getElementById('tcSearchInput').focus(); }, 0);
    }

    // Hide search, show the selected-item chip
    function selectItem(item) {
      selectedItem = item;
      document.getElementById('tcSearchWrap').style.display = 'none';
      var chip = document.getElementById('tcSelectedChip');
      chip.style.display = '';
      document.getElementById('tcChipContent').innerHTML =
        (item.type ? '<span class="tc-item-type">' + escapeHtml(item.type) + '</span> ' : '') +
        '<span class="wi-id">#' + item.id + '</span> ' +
        '<span class="wi-title">' + escapeHtml(item.title) + '</span>';
      document.getElementById('tcFormMsg').style.display = 'none';
      setTimeout(function() { document.getElementById('tcHours').focus(); }, 0);
    }

    function renderList(items, groupLabel) {
      var list = document.getElementById('tcItemList');
      if (!items || !items.length) {
        list.innerHTML = '<div class="tc-item-empty">' +
          escapeHtml(groupLabel || 'No items found') + '</div>';
        return;
      }
      list.innerHTML =
        (groupLabel ? '<div class="tc-item-group">' + escapeHtml(groupLabel) + '</div>' : '') +
        items.map(function(item) {
          return '<button class="tc-item-row">' +
            (item.type ? '<span class="tc-item-type">' + escapeHtml(item.type) + '</span> ' : '') +
            '<span class="wi-id">#' + item.id + '</span> ' +
            '<span class="wi-title tc-item-title">' + escapeHtml(item.title || '(untitled)') + '</span>' +
          '</button>';
        }).join('');
      var cached = items;
      Array.prototype.forEach.call(list.querySelectorAll('.tc-item-row'), function(btn, i) {
        btn.addEventListener('click', function() { selectItem(cached[i]); });
      });
    }

    function doSearch(raw) {
      var q = (raw || '').trim();
      var statusEl = document.getElementById('tcSearchStatus');
      if (!q) {
        statusEl.textContent = '';
        renderList(config.recentItems || [], 'Recently used');
        return;
      }
      // Pure number → direct work item ID lookup
      if (/^\d+$/.test(q)) {
        statusEl.textContent = 'Looking up #' + q + '…';
        config.witClientGetter().then(function(c) {
          return c.getWorkItem(parseInt(q, 10), null, null, 0);
        }).then(function(wi) {
          statusEl.textContent = '';
          renderList([{
            id: wi.id,
            title: wi.fields['System.Title'],
            type: wi.fields['System.WorkItemType']
          }], null);
        }).catch(function() {
          statusEl.textContent = '';
          renderList([], 'No work item found for #' + q);
        });
        return;
      }
      if (q.length < 2) {
        statusEl.textContent = 'Type at least 2 characters…';
        renderList([], '');
        return;
      }
      statusEl.textContent = 'Searching…';
      config.witClientGetter().then(function(c) {
        var safe = q.replace(/'/g, "''");
        var proj = config.projectName || '';
        var wiql = { query:
          'SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS \'' + safe + '\'' +
          (proj ? ' AND [System.TeamProject] = \'' + proj.replace(/'/g, "''") + '\'' : '') +
          ' AND [System.State] NOT IN (\'Closed\',\'Done\',\'Removed\',\'Resolved\',\'Completed\')' +
          ' ORDER BY [System.ChangedDate] DESC'
        };
        return c.queryByWiql(wiql, proj ? { project: proj } : null, false, 20)
          .then(function(res) {
            var ids = (res.workItems || []).map(function(w) { return w.id; }).slice(0, 20);
            if (!ids.length) return [];
            return c.getWorkItems(ids, proj || null,
              ['System.Id', 'System.Title', 'System.WorkItemType'], null, null, 2)
              .then(function(rows) {
                return (rows || []).map(function(wi) {
                  return { id: wi.id, title: wi.fields['System.Title'], type: wi.fields['System.WorkItemType'] };
                });
              });
          });
      }).then(function(results) {
        statusEl.textContent = '';
        if (!results.length) {
          document.getElementById('tcItemList').innerHTML =
            '<div class="tc-item-empty">No results for &ldquo;' + escapeHtml(q) + '&rdquo;</div>';
        } else {
          renderList(results, null);
        }
      }).catch(function() {
        statusEl.textContent = '';
        renderList([], 'Search failed — check your connection');
      });
    }

    function doSave() {
      var hours = parseFloat(document.getElementById('tcHours').value);
      var date  = document.getElementById('tcDate').value;
      var desc  = document.getElementById('tcDesc').value.trim();
      var msgEl = document.getElementById('tcFormMsg');
      function showErr(msg) {
        msgEl.textContent = msg;
        msgEl.className = 'message error';
        msgEl.style.display = '';
      }
      if (!selectedItem)                      { showErr('Select a work item first'); return; }
      if (!hours || hours <= 0 || hours > 24) { showErr('Enter valid hours (0.25–24)'); return; }
      if (!date)                              { showErr('Pick a date'); return; }

      var saveBtn = document.getElementById('tcSaveBtn');
      saveBtn.disabled = true;
      msgEl.style.display = 'none';

      var sameItem = config.entryId && config.initialItem && selectedItem.id === config.initialItem.id;
      var p;
      if (config.entryId && sameItem) {
        p = updateEntry(config.dataService, config.entryId, config.originalDate,
          { hours: hours, date: date, description: desc });
      } else if (config.entryId) {
        p = config.witClientGetter().then(function(c) {
          return buildEntryForWorkItem(c, selectedItem.id, config.currentUser,
            { hours: hours, date: date, description: desc });
        }).then(function(newEntry) {
          return deleteEntryById(config.dataService, config.entryId, config.originalDate)
            .then(function() { return saveEntry(config.dataService, newEntry); });
        });
      } else {
        p = config.witClientGetter().then(function(c) {
          return buildEntryForWorkItem(c, selectedItem.id, config.currentUser,
            { hours: hours, date: date, description: desc });
        }).then(function(entry) {
          return saveEntry(config.dataService, entry);
        });
      }
      p.then(function() {
        close();
        if (config.onSaved) config.onSaved();
      }).catch(function(e) {
        showErr('Error: ' + (e && e.message ? e.message : 'could not save'));
        saveBtn.disabled = false;
      });
    }

    document.getElementById('tcSearchInput').addEventListener('input', function(ev) {
      clearTimeout(searchTimer);
      var q = ev.target.value;
      searchTimer = setTimeout(function() { doSearch(q); }, 300);
    });
    document.getElementById('tcSelectedChip').addEventListener('click', openSearch);
    document.getElementById('tcSaveBtn').addEventListener('click', doSave);
    document.getElementById('tcAddClose').addEventListener('click', close);
    backdrop.addEventListener('click', function(ev) { if (ev.target === backdrop) close(); });
    function onEsc(ev) { if (ev.key === 'Escape') close(); }
    document.addEventListener('keydown', onEsc);

    // Pre-fill for edit mode, otherwise start with the search open
    if (config.initialItem) {
      selectItem(config.initialItem);
      if (config.initialHours !== undefined) document.getElementById('tcHours').value = config.initialHours;
      if (config.initialDate)               document.getElementById('tcDate').value  = config.initialDate;
      if (config.initialDesc)               document.getElementById('tcDesc').value  = config.initialDesc;
    } else {
      openSearch();
    }
  }

  global.TimeCore = {
    STORAGE_KEY_PREFIX: STORAGE_KEY_PREFIX,
    CLIENT_FIELD_REFS: CLIENT_FIELD_REFS,
    PROJECT_FIELD_REFS: PROJECT_FIELD_REFS,
    getFieldValue: getFieldValue,
    localISODate: localISODate,
    todayISO: todayISO,
    startOfWeek: startOfWeek,
    weekDates: weekDates,
    getStorageKeyForDate: getStorageKeyForDate,
    recentMonthKeys: recentMonthKeys,
    monthKeysBetween: monthKeysBetween,
    getEntriesForMonth: getEntriesForMonth,
    loadEntriesForMonths: loadEntriesForMonths,
    loadEntriesForKeys: loadEntriesForKeys,
    saveEntry: saveEntry,
    deleteEntryById: deleteEntryById,
    EDIT_ICON: EDIT_ICON,
    DELETE_ICON: DELETE_ICON,
    escapeHtml: escapeHtml,
    updateEntry: updateEntry,
    buildEntryForWorkItem: buildEntryForWorkItem,
    openAddEntryModal: openAddEntryModal
  };
})(window);

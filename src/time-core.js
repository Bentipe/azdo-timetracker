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
    buildEntryForWorkItem: buildEntryForWorkItem
  };
})(window);

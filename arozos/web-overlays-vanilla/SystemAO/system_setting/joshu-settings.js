/*
    Joshu changes to the ArozOS System Settings page (upstream e3819d1 and later).

    scripts/apply_arozos_joshu_theme.py copies this file next to main.js and loads
    it before main.js. Upstream rewrote the page into index.html, main.js, and
    main.css, so the old text patches of index.html do not apply.

    The file changes the answers of the setting list endpoint and the answers of
    applocale.getString(). It does not change a function of main.js, so a rename
    inside main.js does not break it.

    What the owner sees:
    - The Joshu group does not show in the sidebar.
    - The upstream groups "AI Integration" and "Containers" do not show in the
      sidebar. A box does not use the AI models or the Docker management of ArozOS.
    - The entries "Screen Share Relay" (group Network) and "Shared Spaces" (group
      Developer Options) do not show. The first one can start the TURN relay
      that the box keeps off, and both belong to stock apps that a box hides.
    - The About group has a Joshu entry that opens the Box State page.
    - The About group has no Vendor entry.
    - The About group and its ArozOS entry have the label "About".
*/
(function () {
    "use strict";

    var SETTING_LIST_PATH = "system/setting/list";
    var JOSHU_GROUP = "Joshu";
    // Groups that the sidebar does not show: the Joshu group (its entry is under
    // About) and two upstream groups that a box does not use.
    var HIDDEN_GROUPS = [JOSHU_GROUP, "AInteg", "Container"];
    // Entries that a group does not show, by the id of the group.
    var HIDDEN_ENTRIES = {
        Network: ["Screen Share Relay"],
        Advance: ["Shared Spaces"]
    };
    var ABOUT_GROUP = "About";
    var JOSHU_ABOUT_ENTRY = {
        Name: "Joshu",
        Desc: "Joshu box snapshots and factory profile",
        IconPath: "img/joshu/chat.png",
        Group: ABOUT_GROUP,
        StartDir: "SystemAO/joshu/box-state.html",
        RequireAdmin: false
    };

    function listGroupOf(url) {
        var match = /[?&]listGroup=([^&#]*)/.exec(url || "");
        return match ? decodeURIComponent(match[1]) : "";
    }

    function hasName(list, name) {
        return list.some(function (item) {
            return item && item.Name === name;
        });
    }

    // Change one answer of the setting list endpoint. The answer is the list of
    // groups, or the list of entries of one group when the URL has listGroup.
    function changeSettingList(list, url) {
        if (!Array.isArray(list)) {
            return list;
        }
        var group = listGroupOf(url);
        if (group === "") {
            return list.filter(function (item) {
                return !item || HIDDEN_GROUPS.indexOf(item.Group) === -1;
            });
        }
        if (group === ABOUT_GROUP) {
            var entries = list.filter(function (item) {
                return !item || item.Name !== "Vendor";
            });
            if (!hasName(entries, JOSHU_ABOUT_ENTRY.Name)) {
                entries.push(JOSHU_ABOUT_ENTRY);
            }
            return entries;
        }
        var hidden = HIDDEN_ENTRIES.hasOwnProperty(group) ? HIDDEN_ENTRIES[group] : null;
        if (hidden) {
            return list.filter(function (item) {
                return !item || hidden.indexOf(item.Name) === -1;
            });
        }
        return list;
    }

    if (window.jQuery && typeof window.jQuery.ajaxPrefilter === "function") {
        window.jQuery.ajaxPrefilter(function (options) {
            var url = options.url || "";
            if (url.indexOf(SETTING_LIST_PATH) === -1) {
                return;
            }
            var stockFilter = options.dataFilter;
            options.dataFilter = function (data, type) {
                var text = stockFilter ? stockFilter.call(this, data, type) : data;
                if (typeof text !== "string") {
                    return text;
                }
                try {
                    return JSON.stringify(changeSettingList(JSON.parse(text), url));
                } catch (ex) {
                    // The answer is not JSON (for example an error page). Leave it.
                    return text;
                }
            };
        });
    }

    // Labels. The locale overlay gives the English labels. The wrapper below also
    // covers a language that has no entry for the key, where upstream shows the
    // raw name "About ArOZ" or "ArozOS".
    if (window.applocale && typeof window.applocale.getString === "function") {
        var stockGetString = window.applocale.getString;
        window.applocale.getString = function (key) {
            var text = stockGetString.apply(this, arguments);
            if (typeof key !== "string") {
                return text;
            }
            if (key.indexOf("menu/group/") === 0 && (text === "About ArOZ" || text === "About ArozOS")) {
                return "About";
            }
            if (key === "tab/about/ArozOS") {
                return "About";
            }
            return text;
        };
    }

    window.__joshuSettingsBranding = true;
})();

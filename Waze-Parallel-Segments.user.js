// ==UserScript==
// @name         Waze Parallel Segments
// @version      2026.08.04.01
// @description  Splits two-way segments into parallel one-way carriageways, and adjusts existing one-way segments to be parallel to a user-drawn guide line. Supports both left-hand and right-hand traffic countries.
// @author       kid4rm90s & copilot (original author J0N4S13)
// @include 	 /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor.*$/
// @exclude      https://www.waze.com/user/*editor/*
// @exclude      https://www.waze.com/*/user/*editor/*
// @connect      greasyfork.org
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @require 	 https://greasyfork.org/scripts/560385/code/WazeToastr.js
// @require      https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js
// @namespace    https://greasyfork.org/users/1087400
/* 
Original Author Thanks : J0N4S13 (jonathanserrario@gmail.com)
Migrated to WME SDK by kid4rm90s
*/
// @downloadURL https://update.greasyfork.org/scripts/491466/Waze%20Parallel%20Segments.user.js
// @updateURL https://update.greasyfork.org/scripts/491466/Waze%20Parallel%20Segments.meta.js
// ==/UserScript==
/**To Do */
// Select segment at one side and another same segment at the other side and it will select all the segments in between.
(function () {
    'use strict';

    // ─── Script metadata ────────────────────────────────────────────────────────
    const updateMessage = `<strong>Whats new?</strong>.<br>` +
        `Added "Make it parallel" feature: select one-way segments, draw a guide line between them without crossing, and they become parallel at the specified distance.<br><br>` +
        `<em>Enjoy Mapping!</em>`;
    const scriptName = GM_info.script.name;
    const scriptVersion = GM_info.script.version;
    const downloadUrl = GM_info.script.downloadURL;
    const forumURL = 'https://greasyfork.org/en/scripts/491466-waze-parallel-segments/feedback';

    // ─── Road type IDs ──────────────────────────────────────────────────────────
    // Road types that are drivable (used in deactivated road-conversion code kept for reference)
    const drivableRoadIds = [3, 4, 6, 7, 2, 1, 22, 8, 20, 17, 15, 18, 19];
    // Road types considered pedestrian (excluded from split)
    const pedestrianRoadIds = [5, 10, 16];

    const language = {
        btnSplit: "Split the segments",
        btnMakeParallel: "Make it parallel",
        strMeters: "m",
        strDistance: "Distance between the two parallel segments:",
        strSelMoreSeg: "Since you have more than 1 segment selected, to use this function make sure that you have selected segments sequentially (from one end to the other) and after executing the script, VERIFY the result obtained.",
        strMakeParallelConfirm: "You are about to make {count} segments parallel. Continue?",
        strMakeParallelGuide: "Draw a guide line on the map — the selected segments will become parallel to it.",
        strMakeParallelSuccess: "Successfully made {count} segment{plural} parallel with {distance}m gap!"
    };

    // ─── State tracking across multi-segment splits ──────────────────────────
    let last_node_A = null;
    let last_node_B = null;
    let last_coord_left_first = null;
    let last_coord_left_last = null;
    let last_coord_right_first = null;
    let last_coord_right_last = null;
    let baseDirection = null;

    // ─── SDK instance ────────────────────────────────────────────────────────
    let sdk = null;

    // ─── Traffic side ────────────────────────────────────────────────────────
    // Re-detected on every split so switching between LHT/RHT countries in the
    // same session always uses the correct setting. Defaults to true (LHT) as a
    // safe fallback if the country cannot be resolved yet.
    let isLeftHandTraffic = true;

    // Detects LHT/RHT for the current edit context.
    // Primary:  segment → primaryStreetId → cityId → countryId → isLeftHandTraffic.
    //           Tied to the segment's own data — reliable in cross-border areas.
    // Fallback: sdk.DataModel.Countries.getTopCountry() — viewport-based, used at
    //           init before any segment is available, or if the chain is incomplete.
    function detectTrafficSide(segmentId) {
        // Primary: walk segment → street → city → country.
        if (segmentId != null) {
            try {
                const seg = sdk.DataModel.Segments.getById({ segmentId });
                if (seg?.primaryStreetId) {
                    const street = sdk.DataModel.Streets.getById({ streetId: seg.primaryStreetId });
                    if (street?.cityId) {
                        const city = sdk.DataModel.Cities.getById({ cityId: street.cityId });
                        if (city?.countryId) {
                            const country = sdk.DataModel.Countries.getById({ countryId: city.countryId });
                            if (country != null) {
                                isLeftHandTraffic = country.isLeftHandTraffic ?? true;
                                console.log(`${scriptName} Traffic side:`, isLeftHandTraffic ? 'LHT' : 'RHT', '— country (from segment chain):', country.name);
                                return;
                            }
                        }
                    }
                }
            } catch (e) {
                console.log(`${scriptName} Segment-chain country detection failed:`, e);
            }
        }
        // Fallback: top country for the current map view.
        try {
            const topCountry = sdk.DataModel.Countries.getTopCountry();
            if (topCountry != null) {
                isLeftHandTraffic = topCountry.isLeftHandTraffic ?? true;
                console.log(`${scriptName} Traffic side:`, isLeftHandTraffic ? 'LHT' : 'RHT', '— country (from getTopCountry):', topCountry.name);
                return;
            }
        } catch (e) {
            console.log(`${scriptName} getTopCountry() failed:`, e);
        }
        console.log(`${scriptName} Could not detect traffic side — keeping`, isLeftHandTraffic ? 'LHT' : 'RHT');
    }

    // ─── Bootstrap ───────────────────────────────────────────────────────────
    function bootstrap() {
        // SDK pattern: use unsafeWindow because @grant directives are present
        unsafeWindow.SDK_INITIALIZED.then(initSdk);
    }

    function initSdk() {
        sdk = unsafeWindow.getWmeSdk({ scriptId: 'Waze-Parallel-Segments', scriptName: scriptName });
        sdk.Events.once({ eventName: 'wme-ready' }).then(init);
    }

    function init() {
        // Best-effort early detection — no segment yet, falls back to getTopCountry().
        detectTrafficSide(null);
        // Register for selection change events (SDK equivalent of selectionManager.events.register)
        sdk.Events.on({ eventName: 'wme-selection-changed', eventHandler: onSelectionChanged });
        // Run once on startup in case something is already selected
        onSelectionChanged();
    }

    // ─── Selection handler ───────────────────────────────────────────────────
    function onSelectionChanged() {
        setTimeout(() => {
            const selection = sdk.Editing.getSelection();
            if (selection && selection.objectType === 'segment') {
                myTimer();
                insertButtons();
            }
        }, 300);
    }

    // ─── myTimer: inject A→B / B→A direction copy buttons ───────────────────
    function myTimer() {
        if (document.getElementById('signsroad')) return;

        const signsroad = document.createElement('div');
        signsroad.id = 'signsroad';

        const btnAB = document.createElement('button');
        btnAB.innerHTML = 'A->B';
        btnAB.id = 'btnAB';
        btnAB.style.cssText = 'height: 20px;font-size:11px';
        btnAB.onclick = function () {
            const selection = sdk.Editing.getSelection();
            if (!selection || selection.objectType !== 'segment') return;
            const segId = selection.ids[0];
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg || !seg.isAtoB) return;  // isAtoB = fwdDirection only
            const center = sdk.Map.getMapCenter();
            const text = center.lon.toFixed(6) + ',' + center.lat.toFixed(6) +
                '|' + segId + '|TRUE|' + seg.fromNodeId + '|' + seg.toNodeId;
            GM_setClipboard(text);
        };

        const btnBA = document.createElement('button');
        btnBA.innerHTML = 'B->A';
        btnBA.id = 'btnBA';
        btnBA.style.cssText = 'height: 20px;font-size:11px';
        btnBA.onclick = function () {
            const selection = sdk.Editing.getSelection();
            if (!selection || selection.objectType !== 'segment') return;
            const segId = selection.ids[0];
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg || !seg.isBtoA) return;  // isBtoA = revDirection only
            const center = sdk.Map.getMapCenter();
            const text = center.lon.toFixed(6) + ',' + center.lat.toFixed(6) +
                '|' + segId + '|FALSE|' + seg.toNodeId + '|' + seg.fromNodeId;
            GM_setClipboard(text);
        };

        const divDirectionBtns = document.createElement('div');
        divDirectionBtns.id = 'divDirectionBtns';
        divDirectionBtns.appendChild(btnAB);
        divDirectionBtns.appendChild(btnBA);

        const divLandmarkScript = document.createElement('div');
        divLandmarkScript.id = 'divLandmarkScript';
        divLandmarkScript.style.cssText = 'float:left;';
        divLandmarkScript.appendChild(signsroad);
        divLandmarkScript.appendChild(divDirectionBtns);

        const editGeneral = document.querySelector('div #segment-edit-general');
        if (editGeneral) {
            editGeneral.prepend(divLandmarkScript);
            divDirectionBtns.style.display = 'none';
        }
    }

    // ─── insertButtons: inject split segment and make-parallel UI ────────────
    function insertButtons() {

        const selection = sdk.Editing.getSelection();
        if (!selection || selection.objectType !== 'segment' || selection.ids.length === 0) return;

        // ── Check 1: split-segment conditions (all two-way, symmetrical lanes) ──
        let canSplit = true;
        for (const segId of selection.ids) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg) continue;
            const fwdLanes = seg.fromLanesInfo?.numberOfLanes ?? 0;
            const revLanes = seg.toLanesInfo?.numberOfLanes ?? 0;
            if (fwdLanes !== revLanes) { canSplit = false; }
            if (!seg.isTwoWay) { canSplit = false; }
            if (pedestrianRoadIds.includes(seg.roadType)) { canSplit = false; }
        }

        // ── Check 2: make-parallel conditions (all one-way, ≥2 segments) ────
        let canMakeParallel = selection.ids.length >= 2;
        for (const segId of selection.ids) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg) continue;
            if (seg.isTwoWay) { canMakeParallel = false; break; }
            if (pedestrianRoadIds.includes(seg.roadType)) { canMakeParallel = false; break; }
        }

        if (!canSplit && !canMakeParallel) return;

        // ── Create shared container (once) ──────────────────────────────────
        if (document.getElementById('split-segment') === null) {
        const strMeters = language.strMeters;

        const selSegmentsDistance = document.createElement('wz-select');
        selSegmentsDistance.id = 'segmentsDistance';
        selSegmentsDistance.setAttribute('data-type', 'numeric');
        selSegmentsDistance.setAttribute('value', '5');
        selSegmentsDistance.style.cssText = 'width: 45%;float:left;';

        const distanceOptions = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 21, 23, 25, 27, 30, 32, 35, 37, 40, 42, 45];
        for (const val of distanceOptions) {
            const opt = document.createElement('wz-option');
            opt.setAttribute('value', String(val));
            opt.textContent = `${val} ${strMeters}`;
            selSegmentsDistance.appendChild(opt);
        }

        const label = document.createElement('wz-label');
        label.textContent = language.strDistance;

            // Split button
            const btnSplit = document.createElement('wz-button');
            btnSplit.setAttribute('color', 'secondary');
            btnSplit.setAttribute('size', 'sm');
            btnSplit.id = 'btnSplitSegments';
            btnSplit.style.cssText = 'float:right;margin-top: 5px;';
            btnSplit.textContent = language.btnSplit;
            btnSplit.addEventListener('click', mainSplitSegments);

            // Make-parallel button
            const btnParallel = document.createElement('wz-button');
            btnParallel.setAttribute('color', 'secondary');
            btnParallel.setAttribute('size', 'sm');
            btnParallel.id = 'btnMakeParallel';
            btnParallel.style.cssText = 'float:right;margin-top: 5px;margin-left: 4px;';
            btnParallel.textContent = language.btnMakeParallel;
            btnParallel.addEventListener('click', onMakeParallelClick);

        const divGroup1 = document.createElement('div');
        divGroup1.appendChild(label);
        divGroup1.appendChild(selSegmentsDistance);
            divGroup1.appendChild(btnSplit);
            divGroup1.appendChild(btnParallel);

        const cnt = document.createElement('div');
        cnt.id = 'split-segment';
        cnt.className = 'form-group';
        cnt.style.cssText = 'display: flex;';
        cnt.appendChild(divGroup1);

        const attrForm = document.querySelector('#segment-edit-general .attributes-form');
        if (attrForm) attrForm.insertAdjacentElement('afterend', cnt);

        // Restore saved distance preference
        const savedDist = localStorage.getItem('metersSplitSegment');
        if (savedDist) selSegmentsDistance.setAttribute('value', savedDist);

        selSegmentsDistance.addEventListener('change', function () {
            localStorage.setItem('metersSplitSegment', selSegmentsDistance.value);
        });
        }

        // ── Toggle button visibility ────────────────────────────────────────
        const splitBtn = document.getElementById('btnSplitSegments');
        const parallelBtn = document.getElementById('btnMakeParallel');
        if (splitBtn) splitBtn.style.display = canSplit ? '' : 'none';
        if (parallelBtn) parallelBtn.style.display = canMakeParallel ? '' : 'none';
    }

    // ─── orderSegments: sort selected segment IDs from one end to the other ───
    function orderSegments() {
        const selection = sdk.Editing.getSelection();
        if (!selection || selection.objectType !== 'segment') return [];
        const selectedIds = selection.ids;
        console.log(`${scriptName} orderSegments: total selected =`, selectedIds.length, 'ids =', selectedIds);

        const nodeOccurrences = [];
        for (const segId of selectedIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg) { console.log(`${scriptName} orderSegments: segment not found in model:`, segId); continue; }
            console.log(`${scriptName} orderSegments: seg ${segId} fromNode=${seg.fromNodeId} toNode=${seg.toNodeId}`);
            if (nodeOccurrences.length > 0) {
                let fromExists = false;
                let toExists = false;
                for (const entry of nodeOccurrences) {
                    if (entry[0] === seg.fromNodeId) { entry[1] = 2; fromExists = true; }
                    if (entry[0] === seg.toNodeId)   { entry[1] = 2; toExists = true; }
                }
                if (!fromExists) nodeOccurrences.push([seg.fromNodeId, 1]);
                if (!toExists)   nodeOccurrences.push([seg.toNodeId, 1]);
            } else {
                nodeOccurrences.push([seg.fromNodeId, 1]);
                nodeOccurrences.push([seg.toNodeId, 1]);
            }
        }
        console.log(`${scriptName} orderSegments: node occurrence map =`, nodeOccurrences);

        let nextNodeId = null;
        for (const entry of nodeOccurrences) {
            if (entry[1] === 1) { nextNodeId = entry[0]; break; }
        }
        console.log(`${scriptName} orderSegments: start node =`, nextNodeId);

        if (nextNodeId === null) {
            // Circular selection or disconnected — fall back to original order
            console.log(`${scriptName} orderSegments: no endpoint node found (circular?), using original order`);
            return [...selectedIds];
        }

        const orderedSegIds = [];
        const remaining = new Set(selectedIds);
        let loopGuard = 0;
        while (remaining.size > 0 && loopGuard < selectedIds.length * 2) {
            loopGuard++;
            let found = false;
            for (const segId of remaining) {
                const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
                if (!seg) { remaining.delete(segId); found = true; break; }
                if (seg.fromNodeId === nextNodeId) {
                    console.log(`${scriptName} orderSegments: placed seg ${segId} (fromNode match, next=${seg.toNodeId})`);
                    orderedSegIds.push(segId);
                    nextNodeId = seg.toNodeId;
                    remaining.delete(segId);
                    found = true;
                    break;
                } else if (seg.toNodeId === nextNodeId) {
                    console.log(`${scriptName} orderSegments: placed seg ${segId} (toNode match, next=${seg.fromNodeId})`);
                    orderedSegIds.push(segId);
                    nextNodeId = seg.fromNodeId;
                    remaining.delete(segId);
                    found = true;
                    break;
                }
            }
            if (!found) {
                console.log(`${scriptName} orderSegments: chain broken at node`, nextNodeId, '— remaining unplaced:', [...remaining]);
                break;
            }
        }
        console.log(`${scriptName} orderSegments: result =`, orderedSegIds);
        return orderedSegIds;
    }

    // ─── mainSplitSegments: entry point for split button ─────────────────────
    function mainSplitSegments() {
        const selection = sdk.Editing.getSelection();
        if (selection && selection.ids.length > 1) {
            WazeToastr.Alerts.confirm(
                scriptName,
                language.strSelMoreSeg,
                function () { executeSplit(); },
                function () { return; },
                "Continue",
                "Cancel"
            );
            return;
        }
        executeSplit();
    }

    // ─── executeSplit: core split logic ──────────────────────────────────────
    // For single segment: pure WME SDK.
    // For multiple connected segments: SDK for split+geometry+direction, but
    // legacy Waze/Action/AddNode (with deferred-dispatch wrapper) to create the
    // inter-segment junction nodes (no SDK splitSegment equivalent for
    // multi-seg junctions). Turn-allowance uses sdk.DataModel.Nodes.allowNodeTurns
    // for both single and multi-segment paths.
    //
    // CRITICAL: All AddNode actions MUST be collected and dispatched AFTER the
    // full createSegments loop. Dispatching AddNode inside the loop corrupts the
    // action-manager state before the next splitSegment call, causing segments
    // after the first to fail silently.
    function executeSplit() {
        const distance = parseFloat(document.getElementById('segmentsDistance').value);
        console.log(`${scriptName} executeSplit start — distance:`, distance);

        last_node_A = null;
        last_node_B = null;
        last_coord_left_first = null;
        last_coord_left_last = null;
        last_coord_right_first = null;
        last_coord_right_last = null;
        baseDirection = null;

        const orderedSegIds = orderSegments();
        console.log(`${scriptName} executeSplit: ordered segment IDs =`, orderedSegIds,
            '(', orderedSegIds.length, 'of', sdk.Editing.getSelection()?.ids?.length, 'selected)');

        if (orderedSegIds.length === 0) {
            console.log(`${scriptName} executeSplit: nothing to split`);
            return;
        }

        // Lazy traffic-side detection — use first segment for accurate per-segment chain lookup.
        detectTrafficSide(orderedSegIds[0]);
        console.log(`${scriptName} executeSplit: isLeftHandTraffic =`, isLeftHandTraffic);

        const isMultiSeg = orderedSegIds.length > 1;

        // AddNode has no SDK equivalent — must use legacy require.
        // ModifyAllConnections → sdk.DataModel.Nodes.allowNodeTurns.
        // UpdateObject(fwdTurnsLocked/revTurnsLocked) is NOT needed: those are UI-only
        // verification flags; allowNodeTurns already sets the final turn state correctly.
        let AddNodeLegacy = null;
        if (isMultiSeg) {
            console.log(`${scriptName} Multi-segment mode: loading legacy AddNode`);
            try {
                AddNodeLegacy = require('Waze/Action/AddNode');
                console.log(`${scriptName} Legacy AddNode loaded OK`);
            } catch (e) {
                console.error(`${scriptName} Failed to load legacy AddNode:`, e);
            }
        }

        // AddNodeWrapper — mirrors the legacy version exactly.
        // Delays getAffectedUniqueIds until the node actually exists, preventing
        // the action manager from throwing when the node hasn't been created yet.
        function AddNodeWrapper(point, segments) {
            const base = new AddNodeLegacy(point, segments);
            const origGetAffected = base.getAffectedUniqueIds.bind(base);
            base.getAffectedUniqueIds = function (dataModel) {
                return this.node ? origGetAffected(dataModel) : [];
            };
            return base;
        }

        const leftSegIds = [];
        const rightSegIds = [];
        let connMode = null;

        // Collect all actions for post-split dispatch — mirroring actionsToAdd in legacy.
        // Dispatching these INSIDE the loop would corrupt the action manager before the
        // next splitSegment call.
        const actionsToAdd = [];

        for (let i = 0; i < orderedSegIds.length; i++) {
            const idsegment = orderedSegIds[i];
            const segment = sdk.DataModel.Segments.getById({ segmentId: idsegment });
            if (!segment) {
                console.log(`${scriptName} executeSplit: segment not found in model (may already be split):`, idsegment);
                continue;
            }

            // Determine how this segment connects to the previous one (by shared node ID)
            if (last_node_A !== null && last_node_B !== null) {
                if (last_node_A === segment.toNodeId)   connMode = 'AB';
                if (last_node_B === segment.fromNodeId) connMode = 'BA';
                if (last_node_A === segment.fromNodeId) connMode = 'AA';
                if (last_node_B === segment.toNodeId)   connMode = 'BB';
                if (i === 1) {
                    if (connMode === 'AB' || connMode === 'AA') baseDirection = 'BA';
                    if (connMode === 'BA' || connMode === 'BB') baseDirection = 'AB';
                    console.log(`${scriptName} executeSplit: baseDirection set to`, baseDirection);
                }
            }

            console.log(`${scriptName} executeSplit: Segment ${i}: id=${idsegment} connMode=${connMode}  fromNode=${segment.fromNodeId} toNode=${segment.toNodeId}  lastA=${last_node_A} lastB=${last_node_B}`);

            if (connMode === 'AA' || connMode === 'BB') {
                last_node_A = segment.toNodeId;
                last_node_B = segment.fromNodeId;
            } else {
                last_node_A = segment.fromNodeId;
                last_node_B = segment.toNodeId;
            }

            const segments = createSegments(segment, distance, connMode);
            if (!segments) {
                console.log(`${scriptName} executeSplit: createSegments returned null for segment`, idsegment);
                continue;
            }
            console.log(`${scriptName} executeSplit: Segment ${i} split → left=${segments[0]} right=${segments[1]}`);
            console.log(`${scriptName} executeSplit: Coord cache after split:`,
                'L[0]:', JSON.stringify(last_coord_left_first),
                'L[-1]:', JSON.stringify(last_coord_left_last),
                'R[0]:', JSON.stringify(last_coord_right_first),
                'R[-1]:', JSON.stringify(last_coord_right_last));

            if (i > 0 && isMultiSeg) {
                const prevLeftId  = leftSegIds[leftSegIds.length - 1];
                const prevRightId = rightSegIds[rightSegIds.length - 1];

                // SDK: read junction coordinates from updated geometry — GeoJSON-native,
                // no W.userscripts.toGeoJSONGeometry conversion needed.
                // For BA/BB: curr-left first point; curr-right last point.
                // For AB/AA: curr-left last point; curr-right first point.
                const currLeftSdk  = sdk.DataModel.Segments.getById({ segmentId: segments[0] });
                const currRightSdk = sdk.DataModel.Segments.getById({ segmentId: segments[1] });
                // Legacy WME objects still required as participants for the AddNode action.
                const prevLeftWme  = W.model.segments.getObjectById(prevLeftId);
                const currLeftWme  = W.model.segments.getObjectById(segments[0]);
                const prevRightWme = W.model.segments.getObjectById(prevRightId);
                const currRightWme = W.model.segments.getObjectById(segments[1]);

                let leftCoord  = null;
                let rightCoord = null;

                if (currLeftSdk && currRightSdk) {
                    const leftCoords  = currLeftSdk.geometry.coordinates;
                    const rightCoords = currRightSdk.geometry.coordinates;
                    if (connMode === 'BA' || connMode === 'BB') {
                        leftCoord  = { type: 'Point', coordinates: leftCoords[0] };
                        rightCoord = { type: 'Point', coordinates: rightCoords[rightCoords.length - 1] };
                    } else { // AB, AA
                        leftCoord  = { type: 'Point', coordinates: leftCoords[leftCoords.length - 1] };
                        rightCoord = { type: 'Point', coordinates: rightCoords[0] };
                    }
                } else {
                    // Fallback to cached coords if SDK can't find the segment yet
                    console.log(`${scriptName} SDK segment not found for coord read, falling back to cache. left:`, segments[0], 'right:', segments[1]);
                    if (connMode === 'BA' || connMode === 'BB') {
                        leftCoord  = { type: 'Point', coordinates: last_coord_left_first };
                        rightCoord = { type: 'Point', coordinates: last_coord_right_last };
                    } else {
                        leftCoord  = { type: 'Point', coordinates: last_coord_left_last };
                        rightCoord = { type: 'Point', coordinates: last_coord_right_first };
                    }
                }

                console.log(`${scriptName} AddNode LEFT  coord=${JSON.stringify(leftCoord)}  segs: prev=${prevLeftId} curr=${segments[0]}  wme: prev=${!!prevLeftWme} curr=${!!currLeftWme}`);
                console.log(`${scriptName} AddNode RIGHT coord=${JSON.stringify(rightCoord)} segs: prev=${prevRightId} curr=${segments[1]}  wme: prev=${!!prevRightWme} curr=${!!currRightWme}`);

                if (prevLeftWme && currLeftWme && leftCoord) {
                    actionsToAdd.push(AddNodeWrapper(leftCoord, [prevLeftWme, currLeftWme]));
                } else {
                    console.log(`${scriptName} AddNode LEFT skipped — missing:`, { prevLeftWme: !!prevLeftWme, currLeftWme: !!currLeftWme, leftCoord });
                }
                if (prevRightWme && currRightWme && rightCoord) {
                    actionsToAdd.push(AddNodeWrapper(rightCoord, [prevRightWme, currRightWme]));
                } else {
                    console.log(`${scriptName} AddNode RIGHT skipped — missing:`, { prevRightWme: !!prevRightWme, currRightWme: !!currRightWme, rightCoord });
                }
            }

            leftSegIds.push(segments[0]);
            rightSegIds.push(segments[1]);
        }

        // ── Phase 2: dispatch all AddNode actions now that all segments are split.
        if (isMultiSeg) {
            console.log(`${scriptName} Dispatching ${actionsToAdd.length} AddNode action(s)`);
            actionsToAdd.forEach(a => W.model.actionManager.add(a));

            // SDK: allowNodeTurns replaces legacy ModifyAllConnections.
            console.log(`${scriptName} Allowing turns at all nodes of produced segments via SDK`);
            for (const segId of [...leftSegIds, ...rightSegIds]) {
                const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
                if (!seg) { console.log(`${scriptName} allowNodeTurns: SDK segment missing for seg`, segId); continue; }
                if (seg.fromNodeId !== null) sdk.DataModel.Nodes.allowNodeTurns({ nodeId: seg.fromNodeId, allow: true });
                if (seg.toNodeId   !== null) sdk.DataModel.Nodes.allowNodeTurns({ nodeId: seg.toNodeId,   allow: true });
            }
        } else {
            // Single segment — pure SDK turn-allowance.
            for (const segId of [...leftSegIds, ...rightSegIds]) {
                const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
                if (!seg) continue;
                if (seg.fromNodeId !== null) sdk.DataModel.Nodes.allowNodeTurns({ nodeId: seg.fromNodeId, allow: true });
                if (seg.toNodeId   !== null) sdk.DataModel.Nodes.allowNodeTurns({ nodeId: seg.toNodeId,   allow: true });
            }
        }

        console.log(`${scriptName} executeSplit done — left segs:`, leftSegIds, '/ right segs:', rightSegIds);
        WazeToastr.Alerts.success(
            scriptName,
            `Successfully split ${leftSegIds.length} segment${leftSegIds.length > 1 ? 's' : ''} with ${distance}m gap!`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  "Make it parallel" feature
    // ═══════════════════════════════════════════════════════════════════════

    // ─── onMakeParallelClick: entry point — draw a guide line ─────────────
    function onMakeParallelClick() {
        const selection = sdk.Editing.getSelection();
        if (!selection || selection.objectType !== 'segment' || selection.ids.length < 2) return;

        const segmentIds = [...selection.ids];
        const distance = parseFloat(document.getElementById('segmentsDistance').value);

        // Show brief guidance toastr before drawing
        WazeToastr.Alerts.info(scriptName, language.strMakeParallelGuide, false, false, 3000);

        sdk.Map.drawLine()
            .then((line) => {
                onDrawLineFinished(line, segmentIds, distance);
            })
            .catch((ex) => {
                if (ex instanceof sdk.Errors.InvalidStateError) {
                    // User cancelled drawing — ignore silently
                    console.log(`${scriptName} Make parallel drawing cancelled`);
                } else {
                    console.error(`${scriptName} Make parallel error:`, ex);
                }
            });
    }

    // ─── onDrawLineFinished: handle the drawn guide line ──────────────────
    function onDrawLineFinished(line, segmentIds, distance) {
        if (segmentIds.length > 2) {
            WazeToastr.Alerts.confirm(
                scriptName,
                language.strMakeParallelConfirm.replace('{count}', segmentIds.length),
                function () { applyMakeParallel(line, segmentIds, distance); },
                function () { return; },
                "Continue",
                "Cancel"
            );
            return;
        }
        applyMakeParallel(line, segmentIds, distance);
    }

    // ─── applyMakeParallel: core logic — offset segments to be parallel ───
    // Strategy: compute segment geometries first (by slicing the offset guide
    // line), then derive node positions from the slice endpoints. This ensures
    // node and geometry are always in sync, preventing kinking on curves while
    // fully reshaping segments to follow the guide line's curvature.
    //   1. Validate the drawn guide line is longer than the segment span
    //   2. Determine which geometric side each segment is on
    //   3. Detect independent chains. If exactly 2 chains, assign opposite
    //      sides (one left, one right) so they spread outward from the guide
    //      line as a parallel pair.
    //   4. Make each chain internally consistent (force mixed-side segments
    //      within a chain to the chain's majority side). This prevents
    //      cross-side nodes inside a chain from collapsing both chains.
    //   5. Detect cross-side shared nodes. If any exist, force all segments
    //      to the majority side to prevent V-shaped kinks.
    //   6. Group by side, slice guide line → offset → per-segment slices,
    //      record node positions from slice endpoints. Set cross-side shared
    //      node positions on guide line, snap their segments
    //   7. Move all nodes
    //   8. Update all segment geometries
    //   9. Re-allow turns at all modified nodes
    function applyMakeParallel(line, segmentIds, distance) {
        console.log(`========== ${scriptName} applyMakeParallel START ==========`);
        console.log(`${scriptName} Params: segmentIds=${JSON.stringify(segmentIds)}, distance=${distance}, halfD=${distance / 2}`);
        console.log(`${scriptName} Guide line coords count:`, line.coordinates.length);
        console.log(`${scriptName} Guide line first coord:`, JSON.stringify(line.coordinates[0]));
        console.log(`${scriptName} Guide line last coord:`, JSON.stringify(line.coordinates[line.coordinates.length - 1]));

        // ── BEFORE snapshot: log original geometry of every selected segment ──
        console.log(`${scriptName} BEFORE snapshot — original segment geometries:`);
        for (const segId of segmentIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (seg) {
                console.log(`${scriptName}   seg ${segId}: fromNode=${seg.fromNodeId}, toNode=${seg.toNodeId}, coords=${JSON.stringify(seg.geometry.coordinates)}`);
            } else {
                console.log(`${scriptName}   seg ${segId}: NOT FOUND in model`);
            }
        }
        // ── Node connectivity map ──────────────────────────────────────────
        console.log(`${scriptName} Node connectivity (which segments connect at each node):`);
        const connMap = {};
        for (const segId of segmentIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg) continue;
            for (const nodeId of [seg.fromNodeId, seg.toNodeId]) {
                if (nodeId === null) continue;
                if (!connMap[nodeId]) connMap[nodeId] = [];
                connMap[nodeId].push(segId);
            }
        }
        for (const [nodeId, segs] of Object.entries(connMap)) {
            const suffix = segs.length > 1 ? ' ← SHARED' : '';
            console.log(`${scriptName}   node ${nodeId}: connected segs=${JSON.stringify(segs)}${suffix}`);
        }

        const halfD = distance / 2;
        const lineCoords = line.coordinates;

        // Simplify the drawn line to reduce vertex count
        const simplified = turf.simplify(turf.lineString(lineCoords), { tolerance: 0.000001, highQuality: true });
        const guideCoords = simplified.geometry.coordinates;

        console.log(`${scriptName} After simplify: coords count=${guideCoords.length}`);
        console.log(`${scriptName} Guide coords (simplified):`, JSON.stringify(guideCoords));

        if (guideCoords.length < 2) {
            console.error(`${scriptName} guide line has too few coordinates`);
            return;
        }

        const guideLine = turf.lineString(guideCoords);
        const guideLengthM = turf.length(guideLine, { units: 'meters' });
        console.log(`${scriptName} Guide line length: ${guideLengthM.toFixed(2)}m`);

        // ── Validate: guide line must be longer than the selected segments ──
        // Project each segment's first and last coordinate onto the guide line
        // and verify they fall within the guide line's interior (not at its tips).
        const marginMeters = 5; // require at least 5m clearance past the furthest projection
        let minDistM = Infinity;
        let maxDistM = -Infinity;

        console.log(`${scriptName} Validation: projecting segment endpoints onto guide line...`);
        for (const segId of segmentIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg) continue;
            const coords = seg.geometry.coordinates;
            for (const coord of [coords[0], coords[coords.length - 1]]) {
                const nearest = turf.nearestPointOnLine(guideLine, turf.point(coord));
                const slice = turf.lineSlice(
                    turf.point(guideCoords[0]),
                    turf.point(nearest.geometry.coordinates),
                    guideLine
                );
                const d = turf.length(slice, { units: 'meters' });
                console.log(`${scriptName}   seg ${segId} endpoint [${coord[0].toFixed(6)},${coord[1].toFixed(6)}] → projected [${nearest.geometry.coordinates[0].toFixed(6)},${nearest.geometry.coordinates[1].toFixed(6)}] (index=${nearest.properties.index}) → ${d.toFixed(2)}m from guide start`);
                if (d < minDistM) minDistM = d;
                if (d > maxDistM) maxDistM = d;
            }
        }
        console.log(`${scriptName} Validation: minDistM=${minDistM === Infinity ? 'N/A' : minDistM.toFixed(2)}m, maxDistM=${maxDistM === -Infinity ? 'N/A' : maxDistM.toFixed(2)}m, guideLengthM=${guideLengthM.toFixed(2)}m`);

        if (minDistM !== Infinity) {
            if (minDistM < marginMeters) {
                console.log(`${scriptName} VALIDATION FAILED: earliest projection ${minDistM.toFixed(1)}m < ${marginMeters}m margin`);
                WazeToastr.Alerts.error(scriptName,
                    `Guide line is too short. The drawn line must extend past both ends of the selected segments. Please draw a longer guide line (minimum ${marginMeters}m clearance at each end).`);
                return;
            }
            if (guideLengthM - maxDistM < marginMeters) {
                console.log(`${scriptName} VALIDATION FAILED: furthest projection ${(guideLengthM - maxDistM).toFixed(1)}m from end < ${marginMeters}m margin`);
                WazeToastr.Alerts.error(scriptName,
                    `Guide line is too short. The drawn line must extend past both ends of the selected segments. Please draw a longer guide line (minimum ${marginMeters}m clearance at each end).`);
                return;
            }
        }
        console.log(`${scriptName} Validation PASSED`);

        // Detect traffic side for log context
        detectTrafficSide(segmentIds[0]);

        // ── Step 1: Determine which geometric side each segment is on ──────
        console.log(`${scriptName} Step 1: determining segment sides...`);
        const segmentSides = {};
        for (const segId of segmentIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (seg) {
                // Compute midpoint for logging
                const coords = seg.geometry.coordinates;
                let sumLon = 0, sumLat = 0;
                for (const c of coords) { sumLon += c[0]; sumLat += c[1]; }
                const midLon = sumLon / coords.length;
                const midLat = sumLat / coords.length;
                const midPt = [midLon, midLat];

                // Debug: compute and log the cross product details
                const guideLineDbg = turf.lineString(guideCoords);
                const nearestDbg = turf.nearestPointOnLine(guideLineDbg, turf.point(midPt));
                const nIdx = nearestDbg.properties.index;
                const nCoord = nearestDbg.geometry.coordinates;
                const p1Dbg = guideCoords[nIdx];
                const p2Dbg = guideCoords[Math.min(nIdx + 1, guideCoords.length - 1)];
                const guideBear = turf.bearing(turf.point(p1Dbg), turf.point(p2Dbg));
                const toSegBear = turf.bearing(
                    turf.point(nCoord),
                    turf.point(midPt)
                );
                const gRad = guideBear * Math.PI / 180;
                const sRad = toSegBear * Math.PI / 180;
                const dxDbg = Math.sin(gRad);
                const dyDbg = Math.cos(gRad);
                const sxDbg = Math.sin(sRad);
                const syDbg = Math.cos(sRad);
                const crossDbg = dxDbg * syDbg - dyDbg * sxDbg;

                segmentSides[segId] = crossDbg > 0 ? 'left' : 'right';
                console.log(`${scriptName}   seg ${segId}: midpoint=[${midLon.toFixed(6)},${midLat.toFixed(6)}], nearest_guide=[${nCoord[0].toFixed(6)},${nCoord[1].toFixed(6)}] (idx=${nIdx}), guideBearing=${guideBear.toFixed(2)}°, toSegmentBearing=${toSegBear.toFixed(2)}°, cross=${crossDbg.toFixed(6)}, side=${segmentSides[segId]}`);
            }
        }

        // ── Step 2: Detect independent chains, assign opposite sides ──────
        // When there are exactly 2 independent chains (segments that don't share
        // nodes), force one to the left side and the other to the right side.
        // This creates a parallel pair offset outward from the guide line — each
        // chain spreads away from the center instead of both crowding one side.
        console.log(`${scriptName} Step 2: detecting independent chains...`);
        const segConnections = {};
        for (const segId of segmentIds) segConnections[segId] = new Set();
        for (const segId of segmentIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg) continue;
            for (const nodeId of [seg.fromNodeId, seg.toNodeId]) {
                if (nodeId === null) continue;
                for (const otherSegId of segmentIds) {
                    if (otherSegId === segId) continue;
                    const otherSeg = sdk.DataModel.Segments.getById({ segmentId: otherSegId });
                    if (!otherSeg) continue;
                    if (otherSeg.fromNodeId === nodeId || otherSeg.toNodeId === nodeId) {
                        segConnections[segId].add(otherSegId);
                    }
                }
            }
        }
        const visited = new Set();
        const chains = [];
        for (const segId of segmentIds) {
            if (visited.has(segId)) continue;
            const chain = [segId];
            visited.add(segId);
            const queue = [segId];
            while (queue.length > 0) {
                const cur = queue.shift();
                for (const n of segConnections[cur]) {
                    if (!visited.has(n)) { visited.add(n); queue.push(n); chain.push(n); }
                }
            }
            chains.push(chain);
        }
        console.log(`${scriptName}   Found ${chains.length} independent chain(s)`);
        for (let ci = 0; ci < chains.length; ci++) {
            const sides = chains[ci].map(sid => segmentSides[sid]);
            console.log(`${scriptName}     Chain ${ci}: ${chains[ci].length} seg(s), sides: ${sides.join(', ')}`);
        }
        // If exactly 2 chains on the same side, spread outward by assigning
        // opposite sides. The chain FURTHER from the guide line (larger perp
        // distance) stays on its detected side; the CLOSER chain flips. This
        // ensures the physically outermost chain stays outward on its natural
        // side, matching the user's spatial expectation.
        if (chains.length === 2) {
            const c0Side = segmentSides[chains[0][0]];
            const c1Side = segmentSides[chains[1][0]];
            if (c0Side === c1Side) {
                // Compute average center and perpendicular distance for each chain
                const chainDist = [0, 0];
                for (let ci = 0; ci < 2; ci++) {
                    let sumLon = 0, sumLat = 0, count = 0;
                    for (const segId of chains[ci]) {
                        const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
                        if (!seg) continue;
                        const coords = seg.geometry.coordinates;
                        for (const c of coords) { sumLon += c[0]; sumLat += c[1]; count++; }
                    }
                    if (count === 0) continue;
                    const center = [sumLon / count, sumLat / count];
                    const nearest = turf.nearestPointOnLine(guideLine, turf.point(center));
                    chainDist[ci] = turf.distance(turf.point(center), turf.point(nearest.geometry.coordinates), { units: 'meters' });
                    console.log(`${scriptName}     Chain ${ci} center distance from guide: ${chainDist[ci].toFixed(2)}m`);
                }
                // Flip the closer chain; keep the further chain on its detected side
                const flipIdx = chainDist[0] < chainDist[1] ? 0 : 1;
                const keepIdx = 1 - flipIdx;
                const flipTo = c0Side === 'left' ? 'right' : 'left';
                console.log(`${scriptName}   Both chains on "${c0Side}" — keeping chain ${keepIdx} (${chainDist[keepIdx].toFixed(2)}m), flipping chain ${flipIdx} (${chainDist[flipIdx].toFixed(2)}m) to "${flipTo}"`);
                for (const segId of chains[flipIdx]) segmentSides[segId] = flipTo;
            }
        }

        // ── Step 3: Make each chain internally consistent ─────────────────
        // Within a chain, segments may detect on different sides, creating
        // cross-side shared nodes inside the chain. This triggers a global
        // majority vote that collapses BOTH chains to one side. Fix by
        // forcing each chain to its own majority side first.
        console.log(`${scriptName} Step 3: making chains internally consistent...`);
        for (let ci = 0; ci < chains.length; ci++) {
            const sideCounts = { left: 0, right: 0 };
            for (const segId of chains[ci]) {
                const side = segmentSides[segId];
                if (side) sideCounts[side]++;
            }
            if (sideCounts.left > 0 && sideCounts.right > 0) {
                const majoritySide = sideCounts.left >= sideCounts.right ? 'left' : 'right';
                console.log(`${scriptName}     Chain ${ci}: mixed (L:${sideCounts.left}, R:${sideCounts.right}) → forcing to "${majoritySide}"`);
                for (const segId of chains[ci]) segmentSides[segId] = majoritySide;
            } else {
                console.log(`${scriptName}     Chain ${ci}: consistent (${sideCounts.left > 0 ? 'left' : 'right'})`);
            }
        }

        // ── Step 4: Detect cross-side shared nodes ─────────────────────────
        console.log(`${scriptName} Step 4: detecting cross-side shared nodes...`);
        const nodeSides = {};
        for (const segId of segmentIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg) continue;
            const side = segmentSides[segId];
            for (const nodeId of [seg.fromNodeId, seg.toNodeId]) {
                if (nodeId === null) continue;
                if (!nodeSides[nodeId]) nodeSides[nodeId] = new Set();
                nodeSides[nodeId].add(side);
            }
        }
        const neutralNodeIds = new Set();
        let hasCrossSideNodes = false;
        for (const [nodeId, sides] of Object.entries(nodeSides)) {
            if (sides.size > 1) {
                neutralNodeIds.add(parseInt(nodeId));
                hasCrossSideNodes = true;
                console.log(`${scriptName}   node ${nodeId}: connected to BOTH left and right — will stay on guide line`);
            }
        }

        // ── Step 5: If cross-side nodes exist, force all to majority side ──
        if (hasCrossSideNodes) {
            const sideCounts = { left: 0, right: 0 };
            for (const side of Object.values(segmentSides)) {
                sideCounts[side]++;
            }
            const majoritySide = sideCounts.left >= sideCounts.right ? 'left' : 'right';
            console.log(`${scriptName}   Cross-side nodes found — forcing all ${segmentIds.length} segments to "${majoritySide}"`);
            for (const segId of segmentIds) {
                segmentSides[segId] = majoritySide;
            }
            neutralNodeIds.clear();
        }

        // ── Step 6: Compute node positions & segment geometries together ──
        // Strategy: create the offset guide line, slice portions for each segment,
        // then derive node positions from the slice endpoints. This ensures node
        // positions and segment endpoints are perfectly in sync — no force-snapping,
        // no kinking. Cross-side shared nodes are the exception (placed on guide line).
        console.log(`${scriptName} Step 6: grouping segments by side and computing offset slices...`);

        const nodeNewPositions = {}; // nodeId → [lon, lat]
        const segmentNewGeometries = {}; // segId → [[lon,lat], ...]

        // Group segments by side with projection info
        const sideGroups = {}; // side → [{segId, fromNodeId, toNodeId, projStart, projEnd, startLoc, endLoc}]
        for (const segId of segmentIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (!seg) continue;
            const side = segmentSides[segId];
            const firstCoord = seg.geometry.coordinates[0];
            const lastCoord = seg.geometry.coordinates[seg.geometry.coordinates.length - 1];
            const projStart = turf.nearestPointOnLine(guideLine, turf.point(firstCoord));
            const projEnd = turf.nearestPointOnLine(guideLine, turf.point(lastCoord));

            if (!sideGroups[side]) sideGroups[side] = [];
            sideGroups[side].push({
                segId,
                fromNodeId: seg.fromNodeId,
                toNodeId: seg.toNodeId,
                projStartCoord: projStart.geometry.coordinates,
                projEndCoord: projEnd.geometry.coordinates,
                startLoc: projStart.properties.location,
                endLoc: projEnd.properties.location
            });
        }

        // Process each side group independently
        for (const [side, segs] of Object.entries(sideGroups)) {
            console.log(`${scriptName}   Processing ${side} side: ${segs.length} segments`);

            // Sort by projection start location along the guide line
            segs.sort((a, b) => Math.min(a.startLoc, a.endLoc) - Math.min(b.startLoc, b.endLoc));

            // Find the true extremes (handling reversed projections)
            let trueMinCoord = null, trueMinLoc = Infinity;
            let trueMaxCoord = null, trueMaxLoc = -Infinity;
            for (const s of segs) {
                const sLoc = Math.min(s.startLoc, s.endLoc);
                const eLoc = Math.max(s.startLoc, s.endLoc);
                const sCoord = s.startLoc <= s.endLoc ? s.projStartCoord : s.projEndCoord;
                const eCoord = s.endLoc >= s.startLoc ? s.projEndCoord : s.projStartCoord;
                if (sLoc < trueMinLoc) { trueMinLoc = sLoc; trueMinCoord = sCoord; }
                if (eLoc > trueMaxLoc) { trueMaxLoc = eLoc; trueMaxCoord = eCoord; }
            }

            // Slice the guide line from min to max and offset it
            const sliceGuideStart = turf.point(trueMinCoord);
            const sliceGuideEnd = turf.point(trueMaxCoord);
            const totalGuideLine = turf.lineString(guideCoords);

            let fullSlice;
            if (trueMinLoc <= trueMaxLoc) {
                fullSlice = turf.lineSlice(sliceGuideStart, sliceGuideEnd, totalGuideLine);
            } else {
                fullSlice = turf.lineSlice(sliceGuideEnd, sliceGuideStart, totalGuideLine);
            }
            let sliceCoords = fullSlice.geometry.coordinates;
            if (sliceCoords.length < 2) {
                sliceCoords = [trueMinCoord, trueMaxCoord];
            }

            // Subdivide short slices to ensure enough offset vertices for curve
            // fidelity — when both endpoints fall on the same guide segment, the
            // slice has only 2 coords and the offset line becomes a straight line.
            if (sliceCoords.length < 8) {
                const guideSliceLine = turf.lineString(sliceCoords);
                const sliceLenKm = turf.length(guideSliceLine, { units: 'kilometers' });
                const targetPoints = 8;
                const subdivided = [];
                for (let i = 0; i <= targetPoints; i++) {
                    const pt = turf.along(guideSliceLine, (i / targetPoints) * sliceLenKm, { units: 'kilometers' });
                    subdivided.push(pt.geometry.coordinates);
                }
                sliceCoords = subdivided;
            }

            console.log(`${scriptName}     ${side} side: slice has ${sliceCoords.length} coords (after subdivision)`);

            // Offset the slice
            const fullOffsetCoords = offsetGuideLine(sliceCoords, halfD, side);
            const offsetLine = turf.lineString(fullOffsetCoords);
            const offsetLengthM = turf.length(offsetLine, { units: 'meters' });
            const totalSpanDeg = trueMaxLoc - trueMinLoc;
            console.log(`${scriptName}     ${side} side: offset has ${fullOffsetCoords.length} coords, length=${offsetLengthM.toFixed(2)}m`);

            // Slice each segment's portion and record positions
            for (const s of segs) {
                const segStartLoc = Math.min(s.startLoc, s.endLoc);
                const segEndLoc = Math.max(s.startLoc, s.endLoc);
                const fracStart = totalSpanDeg > 0 ? (segStartLoc - trueMinLoc) / totalSpanDeg : 0;
                const fracEnd = totalSpanDeg > 0 ? (segEndLoc - trueMinLoc) / totalSpanDeg : 1;

                const distStart = Math.max(0, fracStart * offsetLengthM);
                const distEnd = Math.min(offsetLengthM, fracEnd * offsetLengthM);
                const ptStartOnOffset = turf.along(offsetLine, distStart, { units: 'meters' });
                const ptEndOnOffset = turf.along(offsetLine, distEnd, { units: 'meters' });

                let segSlice = turf.lineSlice(ptStartOnOffset, ptEndOnOffset, offsetLine);
                let segCoords = segSlice.geometry.coordinates;

                // Reverse if the segment's original orientation was reversed
                if (s.startLoc > s.endLoc) {
                    segCoords.reverse();
                }

                if (segCoords.length < 2) {
                    segCoords = [ptStartOnOffset.geometry.coordinates, ptEndOnOffset.geometry.coordinates];
                }

                // Record node positions from slice endpoints (unless cross-side shared)
                if (!neutralNodeIds.has(s.fromNodeId) && !nodeNewPositions[s.fromNodeId]) {
                    nodeNewPositions[s.fromNodeId] = segCoords[0];
                }
                if (!neutralNodeIds.has(s.toNodeId) && !nodeNewPositions[s.toNodeId]) {
                    nodeNewPositions[s.toNodeId] = segCoords[segCoords.length - 1];
                }

                segmentNewGeometries[s.segId] = segCoords;
                console.log(`${scriptName}     seg ${s.segId} (${side}): frac=[${fracStart.toFixed(4)},${fracEnd.toFixed(4)}], offset slice has ${segCoords.length} coords`);
            }
        }

        // ── Step 7: Set cross-side shared node positions (on guide line) ──
        console.log(`${scriptName} Step 7: setting ${neutralNodeIds.size} cross-side shared node(s) on guide line...`);
        for (const nodeId of neutralNodeIds) {
            const node = sdk.DataModel.Nodes.getById({ nodeId });
            if (!node) continue;
            const nearest = turf.nearestPointOnLine(guideLine, turf.point(node.geometry.coordinates));
            nodeNewPositions[nodeId] = nearest.geometry.coordinates;
            console.log(`${scriptName}   neutral node ${nodeId} → guide line [${nearest.geometry.coordinates[0].toFixed(6)},${nearest.geometry.coordinates[1].toFixed(6)}]`);

            // For cross-side shared nodes, snap connected segment endpoints to this position
            for (const segId of segmentIds) {
                const segCoords = segmentNewGeometries[segId];
                if (!segCoords) continue;
                const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
                if (!seg) continue;
                if (seg.fromNodeId === nodeId) {
                    segCoords[0] = nodeNewPositions[nodeId];
                }
                if (seg.toNodeId === nodeId) {
                    segCoords[segCoords.length - 1] = nodeNewPositions[nodeId];
                }
            }
        }
        console.log(`${scriptName} Step 7: ${Object.keys(nodeNewPositions).length} unique node positions computed`);

        // ── Step 8: Move all nodes ─────────────────────────────────────────
        console.log(`${scriptName} Step 8: moving ${Object.keys(nodeNewPositions).length} unique nodes...`);
        for (const [nodeIdStr, newPos] of Object.entries(nodeNewPositions)) {
            console.log(`${scriptName}   moveNode id=${nodeIdStr} → [${newPos[0].toFixed(6)},${newPos[1].toFixed(6)}]`);
            sdk.DataModel.Nodes.moveNode({
                id: parseInt(nodeIdStr),
                geometry: { type: 'Point', coordinates: newPos }
            });
        }

        // ── Step 9: Update segment geometries ──────────────────────────────
        console.log(`${scriptName} Step 9: updating ${Object.keys(segmentNewGeometries).length} segment geometries (offset-sliced, follows guide line shape)...`);
        for (const [segId, coords] of Object.entries(segmentNewGeometries)) {
            if (coords.length >= 2) {
                sdk.DataModel.Segments.updateSegment({
                    segmentId: parseInt(segId),
                    geometry: { type: 'LineString', coordinates: coords }
                });
            }
        }

        // ── Step 10: Allow turns at all modified nodes ─────────────────────
        console.log(`${scriptName} Step 10: allowing turns at ${Object.keys(nodeNewPositions).length} nodes...`);
        for (const nodeIdStr of Object.keys(nodeNewPositions)) {
            console.log(`${scriptName}   allowNodeTurns node ${nodeIdStr}`);
            sdk.DataModel.Nodes.allowNodeTurns({ nodeId: parseInt(nodeIdStr), allow: true });
        }

        console.log(`========== ${scriptName} applyMakeParallel END ==========`);

        // ── AFTER snapshot: log final geometry of every selected segment ──
        console.log(`${scriptName} AFTER snapshot — final segment geometries:`);
        for (const segId of segmentIds) {
            const seg = sdk.DataModel.Segments.getById({ segmentId: segId });
            if (seg) {
                console.log(`${scriptName}   seg ${segId}: fromNode=${seg.fromNodeId}, toNode=${seg.toNodeId}, coords=${JSON.stringify(seg.geometry.coordinates)}`);
            } else {
                console.log(`${scriptName}   seg ${segId}: NOT FOUND in model after update`);
            }
        }

        const msg = language.strMakeParallelSuccess
            .replace('{count}', segmentIds.length)
            .replace('{plural}', segmentIds.length > 1 ? 's' : '')
            .replace('{distance}', distance);
        WazeToastr.Alerts.success(scriptName, msg);
    }

    // ─── determineSideOfLine: which geometric side of a guide line a segment is on ──
    function determineSideOfLine(segmentCoords, guideCoords) {
        // Compute the midpoint of the segment geometry
        let sumLon = 0;
        let sumLat = 0;
        for (const coord of segmentCoords) {
            sumLon += coord[0];
            sumLat += coord[1];
        }
        const midLon = sumLon / segmentCoords.length;
        const midLat = sumLat / segmentCoords.length;

        // Build a turf line from the guide coords
        const guideLine = turf.lineString(guideCoords);
        const nearest = turf.nearestPointOnLine(guideLine, turf.point([midLon, midLat]));

        const nearestLon = nearest.geometry.coordinates[0];
        const nearestLat = nearest.geometry.coordinates[1];

        // The segment (index) of the guide line containing the nearest point
        const idx = nearest.properties.index;
        const p1 = guideCoords[idx];
        const p2 = guideCoords[Math.min(idx + 1, guideCoords.length - 1)];

        // Bearing of the guide line at the nearest point
        const bearing = turf.bearing(turf.point(p1), turf.point(p2));

        // Bearing from the nearest point to the segment midpoint
        const toSegment = turf.bearing(
            turf.point([nearestLon, nearestLat]),
            turf.point([midLon, midLat])
        );

        // Cross product (z-component) between guide direction and segment direction.
        // IMPORTANT: turf.bearing uses 0° = North, but Math.cos/sin use 0° = East.
        // Swap sin/cos to convert from bearing convention to vector components.
        const bearingRad = bearing * Math.PI / 180;
        const toSegmentRad = toSegment * Math.PI / 180;
        const dx = Math.sin(bearingRad);   // sin, not cos — bearing 0°=North → x=0
        const dy = Math.cos(bearingRad);   // cos, not sin — bearing 0°=North → y=1
        const sx = Math.sin(toSegmentRad);
        const sy = Math.cos(toSegmentRad);
        const cross = dx * sy - dy * sx;

        return cross > 0 ? 'left' : 'right';
    }

    // ─── offsetGuideLine: offset a line's coordinates perpendicularly ──────
    // Offsets each point of the guide line by halfD in the given geometric
    // side direction (left or right). Uses turf.destination for WGS84 math.
    function offsetGuideLine(guideCoords, halfD, side) {
        const result = [];
        const halfDKm = halfD / 1000;

        for (let i = 0; i < guideCoords.length; i++) {
            let bearing;
            if (i === 0) {
                // First point: use direction to next point
                bearing = turf.bearing(turf.point(guideCoords[i]), turf.point(guideCoords[i + 1]));
            } else if (i === guideCoords.length - 1) {
                // Last point: use direction from previous point
                bearing = turf.bearing(turf.point(guideCoords[i - 1]), turf.point(guideCoords[i]));
            } else {
                // Middle point: average of incoming and outgoing bearings
                const bearingIn = turf.bearing(turf.point(guideCoords[i - 1]), turf.point(guideCoords[i]));
                const bearingOut = turf.bearing(turf.point(guideCoords[i]), turf.point(guideCoords[i + 1]));
                bearing = (bearingIn + bearingOut) / 2;
            }

            // Perpendicular offset — purely geometric, not traffic-side dependent
            const offsetBearing = side === 'left'
                ? (bearing - 90 + 360) % 360
                : (bearing + 90) % 360;

            const dest = turf.destination(turf.point(guideCoords[i]), halfDKm, offsetBearing, { units: 'kilometers' });
            result.push(dest.geometry.coordinates);
        }

        return result;
    }

    // ─── createSegments: split one segment and compute offset geometries ──────
    // 
    // NOTE: OpenLayers geometry operations (rotate, resize, clone on OL.Geometry.Point)
    // are replaced here with turf.js equivalents.
    // turf works in WGS84 (lon/lat). WME SDK segment.geometry is a GeoJSON LineString
    // already in WGS84.
    //
    function createSegments(sel, displacement, connMode) {
        console.log(`${scriptName} createSegments: segId=`, sel.id, 'displacement=', displacement, 'connMode=', connMode);
        // SDK: segment.geometry is already a GeoJSON LineString { type:'LineString', coordinates:[[lon,lat],...] }
        const geomCoords = sel.geometry.coordinates;

        // Simplify geometry: for performance, keep only significant vertices.
        // turf.simplify works in WGS84 (lon/lat degrees).
        const lineFeature = turf.lineString(geomCoords);
        // tolerance in degrees ≈ 0.000001 is ~0.1m; 0.00001 is ~1m — use small value to preserve shape
        const simplified = turf.simplify(lineFeature, { tolerance: 0.000001, highQuality: true });
        const streetCoords = simplified.geometry.coordinates; // [[lon,lat], ...]

        let leftPoints = null;
        let rightPoints = null;
        let prevLeftEq = null;
        let prevRightEq = null;
        let leftPa, rightPa, leftPb, rightPb;

        // displacement is in meters; convert to displacement/2 for each side
        const halfD = displacement / 2;

        for (let i = 0; i < streetCoords.length - 1; i++) {
            const pa = streetCoords[i];   // [lon, lat]
            const pb = streetCoords[i + 1]; // [lon, lat]

            // Bearing from pa to pb
            const bearing = turf.bearing(turf.point(pa), turf.point(pb));

            // LHT (driving on left): left carriageway = bearing-90, right = bearing+90.
            // RHT (driving on right): sides are physically swapped — invert the offsets.
            const bearingLeft  = isLeftHandTraffic ? (bearing - 90 + 360) % 360 : (bearing + 90) % 360;
            const bearingRight = isLeftHandTraffic ? (bearing + 90) % 360 : (bearing - 90 + 360) % 360;

            // Distance along segment for offset endpoints
            const segLenKm = turf.distance(turf.point(pa), turf.point(pb)); // km
            const halfDKm = halfD / 1000;

            // Compute offset points at distance halfD from each vertex, perpendicular to bearing
            // "Extend" pa backward along bearing by halfD to get offset origin, then rotate
            const leftPaPoint  = turf.destination(turf.point(pa), halfDKm, bearingLeft,  { units: 'kilometers' });
            const rightPaPoint = turf.destination(turf.point(pa), halfDKm, bearingRight, { units: 'kilometers' });
            const leftPbPoint  = turf.destination(turf.point(pb), halfDKm, bearingLeft,  { units: 'kilometers' });
            const rightPbPoint = turf.destination(turf.point(pb), halfDKm, bearingRight, { units: 'kilometers' });

            leftPa  = leftPaPoint.geometry.coordinates;
            rightPa = rightPaPoint.geometry.coordinates;
            leftPb  = leftPbPoint.geometry.coordinates;
            rightPb = rightPbPoint.geometry.coordinates;

            // Line equations for intersection calculation (in geographic coords)
            const leftEq  = getEquation({ x1: leftPa[0],  y1: leftPa[1],  x2: leftPb[0],  y2: leftPb[1] });
            const rightEq = getEquation({ x1: rightPa[0], y1: rightPa[1], x2: rightPb[0], y2: rightPb[1] });

            if (leftPoints === null && rightPoints === null) {
                leftPoints  = [leftPa];
                rightPoints = [rightPa];
            } else {
                const li = intersectX(leftEq, prevLeftEq);
                const ri = intersectX(rightEq, prevRightEq);

                if (li && ri) {
                    leftPoints.unshift(li);
                    rightPoints.push(ri);
                    if (i === 0) {
                        leftPoints  = [li];
                        rightPoints = [ri];
                    }
                } else {
                    leftPoints.unshift([...leftPb]);
                    rightPoints.push([...rightPb]);
                    if (i === 0) {
                        leftPoints  = [[...leftPb]];
                        rightPoints = [[...rightPb]];
                    }
                }
            }

            prevLeftEq  = leftEq;
            prevRightEq = rightEq;
        }

        // Append final point
        leftPoints.push([...leftPb]);
        rightPoints.push([...rightPb]);

        // Rotate left array so first→last ordering is consistent
        leftPoints.unshift(leftPoints[leftPoints.length - 1]);
        leftPoints.pop();

        // Split the original segment at midpoint using SDK
        console.log(`${scriptName} createSegments: calling SplitSegment, leftPoints=`, leftPoints.length, 'rightPoints=', rightPoints.length);
        const splitIds = SplitSegment(sel);
        if (!splitIds) return null;

        // Reverse both so they flow A→B
        leftPoints  = leftPoints.reverse();
        rightPoints = rightPoints.reverse();

        // For AA/BB connection modes, swap left/right
        if (connMode === "AA" || connMode === "BB") {
            const aux  = leftPoints;
            leftPoints  = rightPoints;
            rightPoints = aux;
        }

        // Adjust endpoints to match previous iteration's cached connector coords
        if (last_coord_left_first !== null && last_coord_left_last !== null &&
            last_coord_right_first !== null && last_coord_right_last !== null) {

            if (connMode === "AB") {
                leftPoints[leftPoints.length - 1]  = last_coord_left_first;
                rightPoints[0]                     = last_coord_right_last;
            }
            if (connMode === "BA") {
                leftPoints[0]                      = last_coord_left_last;
                rightPoints[rightPoints.length - 1] = last_coord_right_first;
            }
            if (connMode === "AA") {
                leftPoints[leftPoints.length - 1]  = last_coord_left_first;
                rightPoints[0]                     = last_coord_right_last;
            }
            if (connMode === "BB") {
                leftPoints[0]                      = last_coord_left_last;
                rightPoints[rightPoints.length - 1] = last_coord_right_first;
            }
        }

        // Cache connector coords for next iteration
        last_coord_left_first  = leftPoints[0];
        last_coord_left_last   = leftPoints[leftPoints.length - 1];
        last_coord_right_first = rightPoints[0];
        last_coord_right_last  = rightPoints[rightPoints.length - 1];

        // Build GeoJSON LineString geometries for SDK updateSegment
        const newGeomLeft  = { type: 'LineString', coordinates: leftPoints };
        const newGeomRight = { type: 'LineString', coordinates: rightPoints };

        const leftSegId  = splitIds[0];
        const rightSegId = splitIds[1];

        console.log(`${scriptName} createSegments: updateSegment geometry left=`, leftSegId, 'right=', rightSegId);
        // SDK: updateSegment with new geometry — replaces UpdateSegmentGeometry action
        sdk.DataModel.Segments.updateSegment({ segmentId: leftSegId,  geometry: newGeomLeft });
        sdk.DataModel.Segments.updateSegment({ segmentId: rightSegId, geometry: newGeomRight });

        // Set direction: one-way A→B for both segments
        // SDK SegmentDirection values: 'A_TO_B' | 'B_TO_A' | 'TWO_WAY'
        const leftSeg  = sdk.DataModel.Segments.getById({ segmentId: leftSegId });
        const rightSeg = sdk.DataModel.Segments.getById({ segmentId: rightSegId });

        if (connMode === "AA" || connMode === "BB") {
            // Swap speed limits when direction is flipped
            if (leftSeg) {
                sdk.DataModel.Segments.updateSegment({
                    segmentId: leftSegId,
                    direction: 'A_TO_B',
                    fwdSpeedLimit: leftSeg.revSpeedLimit,
                    revSpeedLimit: leftSeg.fwdSpeedLimit
                });
            }
            if (rightSeg) {
                sdk.DataModel.Segments.updateSegment({
                    segmentId: rightSegId,
                    direction: 'A_TO_B',
                    fwdSpeedLimit: rightSeg.revSpeedLimit,
                    revSpeedLimit: rightSeg.fwdSpeedLimit
                });
            }
        } else {
            sdk.DataModel.Segments.updateSegment({ segmentId: leftSegId,  direction: 'A_TO_B' });
            sdk.DataModel.Segments.updateSegment({ segmentId: rightSegId, direction: 'A_TO_B' });
        }

        console.log(`${scriptName} createSegments done — returning`, splitIds);
        return splitIds;
    }
    // Replaces legacy Waze/Action/SplitSegments require() pattern.
    // SDK: DataModel.Segments.splitSegment({ segmentId, splitPoint: GeoJSON Point })
    //
    function SplitSegment(seg) {
        console.log(`${scriptName} SplitSegment: segId=`, seg.id, 'coords=', seg.geometry.coordinates.length);
        if (!sdk.DataModel.Segments.hasPermissions({ segmentId: seg.id })) {
            console.log(`${scriptName} SplitSegment: no permissions for segment`, seg.id);
            return undefined;
        }

        const coords = seg.geometry.coordinates;
        if (!coords || coords.length < 2) return undefined;

        // Ensure at least 3 points (insert midpoint if only 2 vertices)
        let workCoords = [...coords];
        if (workCoords.length === 2) {
            const mid = [
                (workCoords[0][0] + workCoords[1][0]) / 2,
                (workCoords[0][1] + workCoords[1][1]) / 2
            ];
            workCoords = [workCoords[0], mid, workCoords[1]];
            // Update geometry first so split point is valid
            sdk.DataModel.Segments.updateSegment({
                segmentId: seg.id,
                geometry: { type: 'LineString', coordinates: workCoords }
            });
        }

        // Split at the middle vertex
        const midIdx = Math.ceil(workCoords.length / 2 - 1);
        const splitPoint = { type: 'Point', coordinates: workCoords[midIdx] };

        const [id1, id2] = sdk.DataModel.Segments.splitSegment({ segmentId: seg.id, splitPoint });
        return [id1, id2];
    }

    // ─── Geometry helpers ────────────────────────────────────────────────────
    // These work in geographic (lon/lat) coordinate space.
    // NOTE: These are the same line-equation helpers as the legacy code —
    // they cannot be replaced by SDK methods as the SDK has no geometry math APIs.
    // Using turf for actual point-offset operations above is the migration path.

    function getEquation(segment) {
        if (segment.x2 === segment.x1) return { x: segment.x1 };
        const slope = (segment.y2 - segment.y1) / (segment.x2 - segment.x1);
        const offset = segment.y1 - slope * segment.x1;
        return { slope, offset };
    }

    function intersectX(eqa, eqb) {
        if (typeof eqa.slope === 'number' && typeof eqb.slope === 'number') {
            if (eqa.slope === eqb.slope) return null;
            const ix = (eqb.offset - eqa.offset) / (eqa.slope - eqb.slope);
            const iy = eqa.slope * ix + eqa.offset;
            return [ix, iy]; // [lon, lat]
        } else if (typeof eqa.x === 'number') {
            return [eqa.x, eqb.slope * eqa.x + eqb.offset];
        } else if (typeof eqb.x === 'number') {
            return [eqb.x, eqa.slope * eqb.x + eqa.offset];
        }
        return null;
    }

    function scriptupdatemonitor() {
        if (WazeToastr?.Ready) {
            const updateMonitor = new WazeToastr.Alerts.ScriptUpdateMonitor(scriptName, scriptVersion, downloadUrl, GM_xmlhttpRequest);
            updateMonitor.start(2, true);
            WazeToastr.Interface.ShowScriptUpdate(scriptName, scriptVersion, updateMessage, downloadUrl, forumURL);
        } else {
            setTimeout(scriptupdatemonitor, 250);
        }
    }
    scriptupdatemonitor();
    bootstrap();

})();

/* Changelog 
2026.07.27.11 - Removed cross-side node alignment (caused lane crossing). Keep per-side
                 projection ranges to prevent segment shortening. Independent chains on
                 opposite sides stay fully separate.
2026.07.27.10 - Fixed "Make it parallel" segment shortening: use per-side projection ranges
                 for fraction calculation (prevents clipping). Align paired junction nodes
                 across side groups in a post-processing step instead.
2026.07.27.09 - Fixed "Make it parallel" node misalignment: average projection positions of
                 paired segments across side groups.
2026.07.27.08 - Fixed "Make it parallel" node misalignment across lanes: use a shared global
                 projection range for both side groups when 2 chains exist. Nodes at the same
                 position along the road now get matching fractions on both offset lines.
2026.07.27.07 - Fixed "Make it parallel" collapse with many segments: make each chain internally
                 consistent before cross-side detection. Mixed-side segments within a chain
                 now get forced to the chain's own majority side, preventing cross-side nodes
                 from triggering a global collapse to one side.
2026.07.27.06 - Fixed "Make it parallel" chain-side swapping: when 2 chains detect on the same
                 side, the chain FURTHER from the guide line stays on its detected side; the
                 CLOSER chain flips. This preserves the physically outermost chain's natural side.
2026.07.27.05 - Fixed "Make it parallel" overlap on same-side independent chains: detect
                 independent chains (segments not sharing nodes). When exactly 2 chains
                 exist, assign opposite sides so they spread outward as a parallel pair.
2026.07.27.04 - Fixed "Make it parallel" majority-side causing overlap on independent chains:
                 only force to majority side when cross-side shared nodes exist. Independent
                 chains on opposite sides (no shared nodes) keep their original sides.
2026.07.27.03 - Fixed "Make it parallel" cross-side distortion: force all selected segments
                 to the same side of the guide line (majority vote) when cross-side nodes
                 exist, preventing V-shaped kinks at shared nodes.
2026.07.27.02 - Fixed "Make it parallel" shape fidelity: restructured to compute segment
                 geometries first (offset-line slicing), then derive node positions from
                 slice endpoints. Follows guide line curvature without kinking.
2026.07.27.01 - Fixed "Make it parallel" kinking on curves: replaced chain-based offset-line slicing
                 with per-vertex projection (RA Util pattern).
2026.07.26.02 - Added "Make it parallel" feature: select two or more one-way segments, click the button, draw a guide line via sdk.Map.drawLine(), and the segments become parallel to the guide line at the specified distance apart. Includes automatic side detection (left/right of guide line), endpoint node movement, and full undo support. Reuses the existing distance dropdown. Cancelling the drawing (Escape) is silently ignored.
                 Fixed sdk.Editing.doActions not a function error: removed wme-sdk-plus dependency. Each SDK mutation call (updateSegment, moveNode, allowNodeTurns) creates its own undo action — matching the existing split feature pattern.
2026.06.29.01 - Fixed issue with lane count and able to split segments with equal number of defined lanes on both sides. Added a check to ensure that the segment has equal or zero defined lane on each side before proceeding with the split.
2026.03.31.01 - Replaced broken segment-address country detection with sdk.Countries.getTopCountry().
                 The SDK Segment interface has no .address property, so seg?.address?.country was
                 always undefined. detectTrafficSide() now calls sdk.Countries.getTopCountry()
                 directly and reads isLeftHandTraffic from the returned Country object.
                 Both LHT and RHT countries are now correctly detected and carriageways are
                 placed on the proper physical sides of the road.
 2026.03.30.08 - Fixed traffic-side detection caching bug: isTrafficSideDetected flag caused RHT
                 countries to be treated as LHT when the editor was previously used in an
                 LHT country in the same session. Removed the flag so detection always
                 re-runs per split. Segment address is now checked first (most accurate);
                 sdk.Countries.getTopCountry() is the fallback. Country name is now logged.
 2026.03.30.07 - Added left-hand vs right-hand traffic detection via sdk.Countries.getTopCountry().
                 Bearing offsets in createSegments() are now swapped for RHT countries so
                 carriageways are placed on the correct physical sides of the road.
 2026.03.30.06 - Removed getPermalink(): clipboard output is not consumed by any external tool,
                 so the permalink field is unnecessary. Removed sdk.Map.getPermalink() call,
                 async/await from direction-copy button handlers, and the helper function.
 2026.03.30.04 - Removed legacy require('Waze/Action/UpdateObject') and fwdTurnsLocked /
                 revTurnsLocked actions: these are UI-only verification flags that do not
                 affect functional correctness. sdk.DataModel.Nodes.allowNodeTurns already
                 sets the final turn state correctly. AddNode is now the only remaining
                 legacy action (no SDK splitSegment equivalent for multi-seg junctions). 2026.03.30.03 - Replaced legacy ModifyAllConnections with sdk.DataModel.Nodes.allowNodeTurns
                 for multi-segment mode (now consistent with single-segment path).
                 Replaced W.model.segments.getObjectById + .attributes.geometry.components +
                 W.userscripts.toGeoJSONGeometry for junction coord reading with
                 sdk.DataModel.Segments.getById + .geometry.coordinates (GeoJSON-native).
                 W.model.segments.getObjectById retained only where AddNode / UpdateObject
                 legacy actions require internal WME objects.
 2026.03.30.02 - Fixed multi-segment split: only the first segment was being split.
                 Fixes:
                   - orderSegments: loop now uses a Set + loop-guard to avoid breaking
                     the chain on disconnected or already-visited segments.
                   - executeSplit: added legacy require('Waze/Action/UpdateObject') to
                     lock turns (fwdTurnsLocked/revTurnsLocked) on each produced segment
                     before AddNode is dispatched — required for junction nodes to form.
                   - AddNode junction coordinates now read directly from the updated WME
                     segment geometry (.attributes.geometry.components) instead of
                     the cached coord variables, matching legacy behaviour exactly.
                   - All collected actions (AddNode + UpdateObject) dispatched together
                     after the split loop, before ModifyAllConnections.
                 Added verbose console.debug logs throughout for easier diagnosis.
 2026.03.30.01 - Migrated from legacy WME API to WME SDK.
                 Geometry math migrated from OpenLayers to turf.js.
                 clipboard copy migrated from execCommand to GM_setClipboard.
*/

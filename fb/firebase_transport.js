'use strict';
/*
 * Firebase transport for the CVPR 2027 human-study page.
 * Pure logic only — NO DOM access. All side effects go through the
 * injected deps: { sdk, storage, now }.
 *
 * In the browser: window.FirebaseTransport = { create: createFirebaseTransport }
 * In Node: require()-able via module.exports.
 */
function createFirebaseTransport(deps) {
  var sdk = deps.sdk;
  var storage = deps.storage;
  var now = deps.now || function () { return Date.now(); };

  function isPermissionDenied(e) {
    return !!(e && e.code === 'permission-denied');
  }

  function pendingKey(phase, prolificId) {
    return 'cvpr_pending_' + phase + '_' + prolificId;
  }

  function savePending(payload) {
    storage.setItem(pendingKey(payload.phase, payload.prolific_id),
                    JSON.stringify(payload));
  }

  function loadPending(phase, prolificId) {
    var raw = storage.getItem(pendingKey(phase, prolificId));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function clearPending(phase, prolificId) {
    storage.removeItem(pendingKey(phase, prolificId));
  }

  async function assign(phase, prolificId, slotIdsArray, hashFallbackFn) {
    var uid = null;
    try {
      var auth = await sdk.signInAnonymously();
      uid = auth && auth.uid;
    } catch (e) {
      return { rater_id: hashFallbackFn(), mode: 'fallback' };
    }
    var assignPath = 'assignments/' + phase + '_' + prolificId;
    var countsPath = 'meta/slotCounts_' + phase;

    for (var attempt = 0; attempt < 3; attempt++) {
      // Fast path: an assignment already exists for this PID.
      try {
        var snap = await sdk.getDoc(sdk.doc(assignPath));
        if (snap.exists()) {
          return { rater_id: snap.data().rater_id, mode: 'server' };
        }
      } catch (e) {
        if (isPermissionDenied(e)) {
          // PID claimed under another UID.
          return { rater_id: hashFallbackFn(), mode: 'fallback' };
        }
        // Other read errors: fall through to the transaction attempt.
      }

      try {
        var result = await sdk.runTransaction(async function (tx) {
          var aSnap = await tx.get(sdk.doc(assignPath));
          if (aSnap.exists()) {
            return { rater_id: aSnap.data().rater_id, mode: 'server' };
          }
          var cSnap = await tx.get(sdk.doc(countsPath));
          var counts = {};
          if (cSnap.exists()) {
            var cData = cSnap.data();
            counts = (cData && cData.counts) || {};
          }
          // Least-used slot; ties -> lowest slot in slotIdsArray order
          // (the caller passes slotIds() = sorted order).
          var best = null;
          var bestCount = Infinity;
          for (var i = 0; i < slotIdsArray.length; i++) {
            var c = counts[slotIdsArray[i]] || 0;
            if (c < bestCount) { bestCount = c; best = slotIdsArray[i]; }
          }
          var newCounts = {};
          for (var j = 0; j < slotIdsArray.length; j++) {
            newCounts[slotIdsArray[j]] = counts[slotIdsArray[j]] || 0;
          }
          newCounts[best] += 1;
          tx.set(sdk.doc(assignPath), {
            prolific_id: prolificId,
            phase: phase,
            rater_id: best,
            uid: uid,
            assignment_mode: 'server',
            created_at: now()
          });
          tx.set(sdk.doc(countsPath), {
            phase: phase,
            counts: newCounts,
            last_pid: prolificId,
            last_slot: best,
            last_uid: uid
          });
          return { rater_id: best, mode: 'server' };
        });
        if (result && result.rater_id) return result;
        // Defensive: a transaction impl that returns nothing — re-read.
        var snap2 = await sdk.getDoc(sdk.doc(assignPath));
        if (snap2.exists()) {
          return { rater_id: snap2.data().rater_id, mode: 'server' };
        }
        throw new Error('transaction returned no result');
      } catch (e) {
        if (isPermissionDenied(e)) {
          return { rater_id: hashFallbackFn(), mode: 'fallback' };
        }
        if (attempt === 2) break;
        // Retry the whole assign.
      }
    }
    return { rater_id: hashFallbackFn(), mode: 'fallback' };
  }

  async function submit(payload) {
    var uid = null;
    try {
      var auth = await sdk.signInAnonymously();
      uid = auth && auth.uid;
    } catch (e) {
      uid = null;
    }
    var path = 'submissions/' + payload.phase + '_' + payload.prolific_id;
    var docData = {
      prolific_id: payload.prolific_id,
      phase: payload.phase,
      rater_id: payload.rater_id,
      submission_uuid: payload.submission_uuid,
      uid: uid,
      submitted_at: now(),
      row_count: payload.responses.length,
      assignment_mode: payload.assignment_mode,
      source: 'web',
      responses: payload.responses
    };

    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        await sdk.setDoc(sdk.doc(path), docData);
        return { state: 'confirmed' };
      } catch (e) {
        // Classify after ANY error (including ambiguous timeouts where
        // the write may in fact have landed).
        try {
          var snap = await sdk.getDoc(sdk.doc(path));
          if (snap.exists()) {
            var data = snap.data();
            if (data && data.submission_uuid === payload.submission_uuid) {
              return { state: 'confirmed' };
            }
            return { state: 'duplicate' };
          }
          // Not exists: genuine failure — continue the retry loop.
        } catch (ge) {
          if (isPermissionDenied(ge)) {
            // Doc exists under another uid.
            return { state: 'duplicate' };
          }
          // Other classification errors: continue the retry loop.
        }
      }
    }
    return { state: 'failed' };
  }

  return {
    assign: assign,
    submit: submit,
    savePending: savePending,
    loadPending: loadPending,
    clearPending: clearPending
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    create: createFirebaseTransport,
    createFirebaseTransport: createFirebaseTransport
  };
}
if (typeof window !== 'undefined') {
  window.FirebaseTransport = { create: createFirebaseTransport };
}

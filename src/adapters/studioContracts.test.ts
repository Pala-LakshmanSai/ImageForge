import { describe, expect, it } from 'vitest';
import { parseStudioState, projectStudioState, validateFinalizationGrant } from './studioContracts';

const requesterId = '11111111-1111-4111-8111-111111111111';
const representativeId = '22222222-2222-4222-8222-222222222222';
const duplicateId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const finalizationId = '77777777-7777-4777-8777-777777777777';

function session(sessionId: string, displayName: string, availability: 'foreground' | 'background' = 'foreground') {
  return {
    session_id: sessionId,
    display_name: displayName,
    availability,
    expires_at: '2026-08-03T10:00:12.000Z',
  };
}

function pendingState(currentSessionId = representativeId) {
  const allSessions = [
    session(requesterId, 'Lakshman'),
    session(representativeId, 'Sujal'),
    session(duplicateId, 'Sujal'),
  ];
  return {
    schema_version: 1,
    server_instance_id: '55555555-5555-4555-8555-555555555555',
    coordination_revision: 7,
    server_time: '2026-08-03T10:00:00.000Z',
    presence_ttl_seconds: 12,
    response_ttl_seconds: 30,
    finalization_ttl_seconds: 10,
    current_session: allSessions.find((candidate) => candidate.session_id === currentSessionId),
    sessions: allSessions,
    active_batch: null,
    stop_request: {
      request_id: requestId,
      pod_id: 'pod-exact-1',
      gpu_display_name: 'RTX 4090',
      requester: { session_id: requesterId, display_name: 'Lakshman' },
      state: 'pending',
      reason: null,
      requested_at: '2026-08-03T10:00:00.000Z',
      response_deadline: '2026-08-03T10:00:30.000Z',
      finalization_expires_at: null,
      waiting_for: [
        { session_id: representativeId, display_name: 'Sujal' },
        { session_id: duplicateId, display_name: 'Sujal' },
      ],
      approved_by: [] as Array<{ session_id: string; display_name: string }>,
      denied_by: [] as Array<{ session_id: string; display_name: string }>,
      finalization_id: null,
    },
  };
}

function finalizingState() {
  const wire = pendingState(requesterId);
  return parseStudioState({
    ...wire,
    stop_request: {
      ...wire.stop_request,
      state: 'finalizing',
      waiting_for: [],
      approved_by: [{ session_id: representativeId, display_name: 'Sujal' }],
      finalization_id: finalizationId,
      finalization_expires_at: '2026-08-03T10:00:45.000Z',
    },
  });
}

describe('studio collaboration contracts', () => {
  it('offers approval to every required foreground session for the principal', () => {
    const representative = projectStudioState(parseStudioState(pendingState(representativeId)));
    expect(representative.stop).toMatchObject({ phase: 'pending', canRespond: true, isRequester: false });

    const duplicate = projectStudioState(parseStudioState(pendingState(duplicateId)));
    expect(duplicate.stop).toMatchObject({ phase: 'pending', canRespond: true, isRequester: false });
  });

  it('accepts approved truth before the desktop creates a finalization ID', () => {
    const wire = pendingState(requesterId);
    wire.stop_request.state = 'approved';
    wire.stop_request.waiting_for = [];
    wire.stop_request.approved_by = [{ session_id: representativeId, display_name: 'Sujal' }];

    const projected = projectStudioState(parseStudioState(wire));

    expect(projected.stop).toMatchObject({
      phase: 'approved',
      isRequester: true,
      finalizationId: null,
      finalizationExpiresAt: null,
    });
  });

  it('keeps the finalization UUID exclusive to the exact requester session', () => {
    const peerWire = pendingState(representativeId) as any;
    peerWire.stop_request = {
      ...peerWire.stop_request,
      state: 'finalizing',
      waiting_for: [],
      approved_by: [{ session_id: representativeId, display_name: 'Sujal' }],
      finalization_expires_at: '2026-08-03T10:00:45.000Z',
      finalization_id: null,
    };
    expect(parseStudioState(peerWire).stopRequest?.finalizationId).toBeNull();

    peerWire.stop_request.finalization_id = finalizationId;
    expect(() => parseStudioState(peerWire)).toThrow('non-requester');

    const requesterWire = pendingState(requesterId) as any;
    requesterWire.stop_request = {
      ...requesterWire.stop_request,
      state: 'finalizing',
      waiting_for: [],
      finalization_expires_at: '2026-08-03T10:00:45.000Z',
      finalization_id: null,
    };
    expect(() => parseStudioState(requesterWire)).toThrow('exact requester');
  });

  it('rejects a guard expiry before the request is actually finalizing', () => {
    const approved = pendingState(requesterId) as any;
    approved.stop_request.state = 'approved';
    approved.stop_request.waiting_for = [];
    approved.stop_request.finalization_expires_at = '2026-08-03T10:00:45.000Z';
    expect(() => parseStudioState(approved)).toThrow('inactive stop request');
  });

  it('rejects unknown fields and malformed session UUIDs', () => {
    expect(() => parseStudioState({ ...pendingState(), bearer_token: 'must never reflect' })).toThrow(
      'unknown field',
    );
    const malformed = pendingState();
    malformed.current_session = { ...malformed.current_session!, session_id: 'not-a-uuid' };
    expect(() => parseStudioState(malformed)).toThrow('UUID v4');
  });

  it('rejects impossible calendar dates instead of accepting Date.parse normalization', () => {
    const impossible = pendingState();
    impossible.server_time = '2026-02-31T10:00:00.000Z';
    expect(() => parseStudioState(impossible)).toThrow('real RFC3339 UTC calendar timestamp');
  });

  it('binds the finalization grant to the exact session, request, Pod, and UUID', () => {
    const state = finalizingState();
    const expected = {
      serverInstanceId: state.serverInstanceId,
      approvedCoordinationRevision: state.coordinationRevision - 1,
      sessionId: requesterId,
      requestId,
      podId: 'pod-exact-1',
      finalizationId,
    };

    expect(validateFinalizationGrant(state, expected, 5_000)).toEqual({ valid: true, remainingMs: 40_000 });
    expect(validateFinalizationGrant(state, { ...expected, requestId: '88888888-8888-4888-8888-888888888888' }, 0)).toEqual({ valid: false, reason: 'request_mismatch' });
    expect(validateFinalizationGrant(state, { ...expected, podId: 'pod-replaced' }, 0)).toEqual({ valid: false, reason: 'pod_mismatch' });
    expect(validateFinalizationGrant(state, { ...expected, finalizationId: '99999999-9999-4999-8999-999999999999' }, 0)).toEqual({ valid: false, reason: 'finalization_mismatch' });
    expect(validateFinalizationGrant(state, { ...expected, sessionId: representativeId }, 0)).toEqual({ valid: false, reason: 'session_mismatch' });
    expect(validateFinalizationGrant(state, { ...expected, serverInstanceId: '99999999-9999-4999-8999-999999999999' }, 0)).toEqual({ valid: false, reason: 'epoch_mismatch' });
    expect(validateFinalizationGrant(state, { ...expected, approvedCoordinationRevision: state.coordinationRevision }, 0)).toEqual({ valid: false, reason: 'revision_stale' });
  });

  it('fails a delayed finalization response closed when too little guard time remains', () => {
    const state = finalizingState();
    expect(validateFinalizationGrant(state, {
      serverInstanceId: state.serverInstanceId,
      approvedCoordinationRevision: state.coordinationRevision - 1,
      sessionId: requesterId,
      requestId,
      podId: 'pod-exact-1',
      finalizationId,
    }, 15_001)).toEqual({ valid: false, reason: 'expiry_too_short' });
  });
});

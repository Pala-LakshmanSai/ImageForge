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
    gpu_switch_can_respond: false,
    gpu_switch_request: null,
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

function pendingSwitchState(currentSessionId = representativeId) {
  const wire = pendingState(currentSessionId);
  return {
    ...wire,
    stop_request: null,
    gpu_switch_can_respond: currentSessionId !== requesterId,
    gpu_switch_request: {
      schema_version: 1,
      switch_id: '66666666-6666-4666-8666-666666666666',
      old_pod_id: 'pod-exact-1',
      old_gpu_id: 'NVIDIA GeForce RTX 4090',
      old_gpu_display_name: 'RTX 4090',
      initial_target_gpu_id: 'NVIDIA RTX 5090',
      initial_target_gpu_display_name: 'RTX 5090',
      initial_replacement_attempt_id: '77777777-7777-4777-8777-777777777777',
      requester: { session_id: requesterId, display_name: 'Lakshman' },
      state: 'pending',
      reason: null,
      requested_at: '2026-08-03T10:00:00.000Z',
      response_deadline: '2026-08-03T10:00:30.000Z',
      ready_to_delete_at: null,
      waiting_for: [{ session_id: representativeId, display_name: 'Sujal' }],
      approved_by: [] as Array<{ session_id: string; display_name: string }>,
      denied_by: [] as Array<{ session_id: string; display_name: string }>,
      batch_id: null,
      batch_owner: null,
      batch_state_at_finalization: null,
      replacement_attempt_id: null,
      replacement_attempt_revision: null,
      replacement_pod_id: null,
      actual_target_gpu_id: null,
    },
  };
}

describe('studio collaboration contracts', () => {
  it('strictly projects the public GPU Switch consent request for the required peer', () => {
    const projected = projectStudioState(parseStudioState(pendingSwitchState()));

    expect(projected.gpuSwitch).toMatchObject({
      switchId: '66666666-6666-4666-8666-666666666666',
      phase: 'pending',
      oldGpuDisplayName: 'RTX 4090',
      initialTargetGpuDisplayName: 'RTX 5090',
      isRequester: false,
      canRespond: true,
    });
  });

  it('uses the authenticated per-session capability for a non-representative peer session', () => {
    const projected = projectStudioState(parseStudioState(pendingSwitchState(duplicateId)));

    expect(projected.gpuSwitch?.waitingFor).toEqual([
      { sessionId: representativeId, displayName: 'Sujal' },
    ]);
    expect(projected.gpuSwitch?.canRespond).toBe(true);

    const requester = pendingSwitchState(requesterId) as any;
    requester.gpu_switch_can_respond = true;
    expect(() => parseStudioState(requester)).toThrow('gpu_switch_can_respond');

    const missingRepresentativeCapability = pendingSwitchState(representativeId) as any;
    missingRepresentativeCapability.gpu_switch_can_respond = false;
    expect(() => parseStudioState(missingRepresentativeCapability)).toThrow('response capability');
  });

  it('rejects terminal, partial-replacement, and private GPU Switch projections', () => {
    const terminal = pendingSwitchState() as any;
    terminal.gpu_switch_request.state = 'completed';
    expect(() => parseStudioState(terminal)).toThrow('tombstone');

    const partial = pendingSwitchState() as any;
    partial.gpu_switch_request.replacement_attempt_id = '88888888-8888-4888-8888-888888888888';
    expect(() => parseStudioState(partial)).toThrow('replacement identity');

    const privateField = pendingSwitchState() as any;
    privateField.gpu_switch_request.principal_binding_id = '99999999-9999-4999-8999-999999999999';
    expect(() => parseStudioState(privateField)).toThrow('unknown field');
  });

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

  it('uses the shared 1-128 byte GPU identity grammar for Stop projections', () => {
    const colon = pendingState();
    colon.stop_request.gpu_display_name = 'NVIDIA RTX PRO 4500:Blackwell 32GB';
    expect(parseStudioState(colon).stopRequest?.gpuDisplayName).toBe('NVIDIA RTX PRO 4500:Blackwell 32GB');

    const oversized = pendingState();
    oversized.stop_request.gpu_display_name = `A${'b'.repeat(127)}Z`;
    expect(() => parseStudioState(oversized)).toThrow('ImageForge GPU identity');

    const invalid = pendingState();
    invalid.stop_request.gpu_display_name = 'NVIDIA/RTX 4090';
    expect(() => parseStudioState(invalid)).toThrow('ImageForge GPU identity');
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

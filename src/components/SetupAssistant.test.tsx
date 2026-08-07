import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeImageForgeAdapter } from '../adapters/imageForgeAdapter';
import type { ImageForgeAdapter } from '../adapters/imageForgeAdapter';
import { createConfiguredInitialState } from '../domain/reducer';
import { SetupAssistant } from './SetupAssistant';

const VAULT_UNAVAILABLE = {
  code: 'credential_vault_unavailable',
  message: 'The login keychain is unavailable to ImageForge in this session.',
  retryable: false,
};

function adapterWith(overrides: Partial<ImageForgeAdapter>): ImageForgeAdapter {
  return { ...createFakeImageForgeAdapter(), ...overrides };
}

describe('SetupAssistant', () => {
  it('shows the vault reason when a credential replacement is rejected natively', async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({
      replaceCredential: vi.fn(async () => {
        throw VAULT_UNAVAILABLE;
      }),
    });

    render(
      <SetupAssistant
        state={createConfiguredInitialState()}
        dispatch={vi.fn()}
        adapter={adapter}
        credentialOnlyKind="runpodApiKey"
      />,
    );

    await user.type(screen.getByLabelText('RunPod API key'), 'rp_live_example_7K2M');
    await user.click(screen.getByRole('button', { name: 'Save RunPod API key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(VAULT_UNAVAILABLE.message);
  });

  it('shows the vault reason when the connection test cannot read credential status', async () => {
    const user = userEvent.setup();
    const adapter = adapterWith({
      credentialMetadata: vi.fn(async () => {
        throw VAULT_UNAVAILABLE;
      }),
    });

    render(
      <SetupAssistant
        state={createConfiguredInitialState()}
        dispatch={vi.fn()}
        adapter={adapter}
        initialStep={3}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Run connection test' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(VAULT_UNAVAILABLE.message);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run connection test' })).toBeEnabled(),
    );
  });
});

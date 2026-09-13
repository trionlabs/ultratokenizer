import type { EIP1193Provider } from 'viem';

export type WalletChoice = Readonly<{
  id: string;
  name: string;
  rdns?: string;
  provider: EIP1193Provider;
}>;
type WalletWindow = EventTarget & { readonly ethereum?: unknown };
type Listener = (choices: readonly WalletChoice[]) => void;
const catalogs = new WeakMap<
  WalletWindow,
  {
    subscribe: (listener: Listener) => () => void;
  }
>();

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && 'value' in property ? property.value : undefined;
}
function isProvider(value: unknown): value is EIP1193Provider {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as EIP1193Provider).request === 'function'
  );
}
function announced(event: Event): WalletChoice | undefined {
  try {
    const detail: unknown = (event as CustomEvent).detail;
    const info = own(detail, 'info');
    const provider = own(detail, 'provider');
    const id = own(info, 'uuid');
    const name = own(info, 'name');
    const rdns = own(info, 'rdns');
    const icon = own(info, 'icon');
    if (
      typeof id !== 'string' ||
      !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
        id,
      ) ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 80 ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name) ||
      typeof rdns !== 'string' ||
      rdns.length > 253 ||
      !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(rdns) ||
      typeof icon !== 'string' ||
      icon.length > 131072 ||
      !icon.startsWith('data:image/') ||
      !isProvider(provider)
    )
      return;
    // Names and rdns are self-attested display metadata, never authority or
    // feature detection. Icons are deliberately neither retained nor rendered.
    return Object.freeze({
      id: id.toLowerCase(),
      name: name.trim(),
      rdns,
      provider,
    });
  } catch {
    return;
  }
}

/** Page-lifetime EIP-6963 discovery, with window.ethereum only as a fallback. */
export function watchWallets(
  target: WalletWindow,
  listener: Listener,
): () => void {
  let catalog = catalogs.get(target);
  if (!catalog) {
    const providers = new Map<string, WalletChoice>();
    const listeners = new Set<Listener>();
    let fallback: WalletChoice | undefined;
    const choices = () =>
      Object.freeze(
        providers.size ? [...providers.values()] : fallback ? [fallback] : [],
      );
    const notify = () => {
      for (const subscriber of listeners) subscriber(choices());
    };
    target.addEventListener('eip6963:announceProvider', (event) => {
      const candidate = announced(event);
      if (!candidate || providers.size >= 32) return;
      // A repeated UUID must never replace the selected provider object. Also
      // deduplicate a wallet that announces the same object under another UUID.
      if (
        providers.has(candidate.id) ||
        [...providers.values()].some(
          (entry) => entry.provider === candidate.provider,
        )
      )
        return;
      providers.set(candidate.id, candidate);
      notify();
    });
    catalog = {
      subscribe(subscriber) {
        listeners.add(subscriber);
        target.dispatchEvent(new Event('eip6963:requestProvider'));
        if (!providers.size && !fallback) {
          try {
            const provider = target.ethereum;
            if (isProvider(provider))
              fallback = Object.freeze({
                id: 'legacy',
                name: 'Browser wallet',
                provider,
              });
          } catch {
            // A competing extension's throwing getter cannot break hydration.
          }
        }
        subscriber(choices());
        return () => {
          listeners.delete(subscriber);
        };
      },
    };
    catalogs.set(target, catalog);
  }
  return catalog.subscribe(listener);
}

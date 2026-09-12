/** Raw text vectors shared by domain checks and the independent native parity runner. */
export function requestJsonCases(request: Record<string, unknown>) {
  const json = JSON.stringify(request);
  const padded =
    json + ' '.repeat(4096 - new TextEncoder().encode(json).byteLength);
  return [
    { name: 'canonical', json, accepted: true },
    {
      name: 'reordered',
      json: JSON.stringify(
        Object.fromEntries(Object.entries(request).reverse()),
      ),
      accepted: true,
    },
    {
      name: 'escaped key',
      json: json.replace('"amount"', '"amo\\u0075nt"'),
      accepted: true,
    },
    {
      name: 'escaped value',
      json: json.replace('"ISSUE"', '"\\u0049SSUE"'),
      accepted: true,
    },
    { name: '4096-byte boundary', json: padded, accepted: true },
    { name: 'over byte boundary', json: padded + ' ', accepted: false },
    {
      name: 'shadowed first amount',
      json: '{"amount":"0",' + json.slice(1),
      accepted: false,
    },
    {
      name: 'repeated last amount',
      json: json.slice(0, -1) + ',"amount":"1"}',
      accepted: false,
    },
    {
      name: 'escaped repeated amount',
      json: json.slice(0, -1) + ',"amo\\u0075nt":"1"}',
      accepted: false,
    },
    {
      name: 'nested duplicate',
      json: json.slice(0, -1) + ',"extra":{"a":1,"a":2}}',
      accepted: false,
    },
    {
      name: 'array duplicate',
      json: json.slice(0, -1) + ',"extra":[{"a":1,"\\u0061":2}]}',
      accepted: false,
    },
    {
      name: 'wrong nested amount',
      json: JSON.stringify({ ...request, amount: { value: '1' } }),
      accepted: false,
    },
    { name: 'truncated', json: json.slice(0, -1), accepted: false },
    { name: 'trailing value', json: json + ' null', accepted: false },
  ];
}

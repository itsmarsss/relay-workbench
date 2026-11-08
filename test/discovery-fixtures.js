export async function mockDiscovery(page) {
  await page.route('**/api/models/discover', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        Object.fromEntries(
          ['codex', 'claude', 'pi'].map((id) => [
            id,
            {
              status: 'ready',
              models: [
                { id: 'example-fast', name: 'Example Fast', efforts: ['low', 'high'] },
                { id: 'example-deep', name: 'Example Deep', efforts: ['high'] },
              ],
            },
          ]),
        ),
      ),
    }),
  );
  await page.route('**/api/repositories/discover', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        repositories: [],
        roots: [],
        directories: 0,
        truncated: false,
        warnings: [],
      }),
    }),
  );
}

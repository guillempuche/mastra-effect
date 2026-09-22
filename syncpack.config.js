/** @type {import("syncpack").RcFile} */
export default {
  // Stated explicitly rather than relying on discovery, so this keeps working if the
  // workspace layout changes. The example is a workspace member; the library itself is the
  // root, which some discovery modes skip.
  source: ['package.json', 'examples/*/package.json'],

  versionGroups: [
    {
      // A peer range states what a consumer may bring; an install pin states
      // what this repo tests against. They are deliberately different: the peer
      // on `effect` is a wide compatibility window, while the devDependency is
      // one exact rc. Forcing them to match would either publish a hostile exact
      // peer or stop pinning what CI actually runs.
      label: 'Peer ranges, which are broader than install pins on purpose',
      dependencies: ['**'],
      dependencyTypes: ['peer'],
      isIgnored: true,
    },
    {
      // The library links itself into the example, so its version is local and
      // never a published range.
      label: 'The library itself, linked into the example',
      dependencies: ['@guillem_puche/mastra-effect'],
      isIgnored: true,
    },
    {
      // Effect and its companion packages are released together on the rc line.
      // @effect/platform-node at a different rc than effect is an immediate type
      // mismatch, and the example imports both.
      label: 'Effect, which must be one version everywhere',
      dependencies: ['effect', '@effect/**'],
      policy: 'sameRange',
    },
    {
      // @mastra/core and @mastra/server must move as a pair, and the example
      // resolves the same copies the library does — two versions means the
      // conformance suite iterates a different route table than the adapter
      // registered, which fails in ways that look nothing like the cause.
      label: 'Mastra, which must be one version everywhere',
      dependencies: ['@mastra/**'],
      policy: 'sameRange',
    },
  ],
};

// PUBLIC addresses only. Never put private keys here.
export const webAgents = {
  network: "devnet",
  programId: "BVhTPuAK9birmLeYBeAuBMusEdYW9oFjQeJeMU9hNX9d",
  owner: "CMbQSedspHrgqKEhUpYrxiaZkoseWcuEMWoLb4Ah7Wc",
  vaultId: "8001",
  vault: "C3mUdw6QPgPdFCC4gFnz8uyrMaD9Y2Qcz4xaLcdWddep",
  treasury: "8yX2mqJcx5ECA2r4gDNkEvTUvAZp6VZvj1rs8t8X1jyp",
  mint: "Dm75S15mto6y3vNeXZ8FENayPCiSev7PqJBmSfZkQW38",
  agents: [
    {
      id: "agent-a",
      name: "Procurement",
      budgetBaseUnits: "150000",
      authority: "D78Jx9mspxFhriHbZkKnpPPuzU7MWdL3dFfpZWV9b9ii",
      recipient: "HgxxSaJw3fzL1u2HRwTXzWcTQUqEx5XdAPU3ESzGtCv",
      taskId: "1",
    },
    {
      id: "agent-b",
      name: "Operations",
      budgetBaseUnits: "100000",
      authority: "7UYdC4PNSZaSnd82o7kBUDGAz67XPKg3ze7DGRzw8mfE",
      recipient: "BqRAXZm6yRwuJCYHuRhqYzH3JT8aJABWdgCuZ1suxaBz",
      taskId: "1",
    },
  ],
} as const;

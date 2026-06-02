export const CONNECTOR_TIERS = [
  'communication',
  'project_management',
  'code',
  'documentation',
  'cicd',
  'observability',
  'intelligence',
] as const;

export type ConnectorTier = (typeof CONNECTOR_TIERS)[number];

export interface TierCapabilities {
  tier: ConnectorTier;
  supportsWebhooks: boolean;
  supportsTranscripts: boolean;
  supportsMultiDecision: boolean;
  supportsIssueCreation: boolean;
  supportsHistoricalImport: boolean;
  supportsDecisionComments: boolean;
  supportsReadOnlyTools: boolean;
  supportsInteractiveCommands: boolean;
  /** Whether this connector receives proactive conflict/supersession notifications from gateway deferred analysis */
  supportsProactiveNotifications: boolean;
}

export const TIER_CAPABILITIES: Record<ConnectorTier, TierCapabilities> = {
  communication: {
    tier: 'communication',
    supportsWebhooks: true,
    supportsTranscripts: true,
    supportsMultiDecision: true,
    supportsIssueCreation: true,
    supportsHistoricalImport: true,
    supportsDecisionComments: true,
    supportsReadOnlyTools: true,
    supportsInteractiveCommands: true,
    supportsProactiveNotifications: true,
  },
  project_management: {
    tier: 'project_management',
    supportsWebhooks: true,
    supportsTranscripts: false,
    supportsMultiDecision: false,
    supportsIssueCreation: false,
    supportsHistoricalImport: true,
    supportsDecisionComments: true,
    supportsReadOnlyTools: true,
    supportsInteractiveCommands: true,
    supportsProactiveNotifications: false,
  },
  code: {
    tier: 'code',
    supportsWebhooks: true,
    supportsTranscripts: false,
    supportsMultiDecision: false,
    supportsIssueCreation: false,
    supportsHistoricalImport: true,
    supportsDecisionComments: true,
    supportsReadOnlyTools: true,
    supportsInteractiveCommands: true,
    supportsProactiveNotifications: false,
  },
  documentation: {
    tier: 'documentation',
    supportsWebhooks: true,
    supportsTranscripts: false,
    supportsMultiDecision: false,
    supportsIssueCreation: false,
    supportsHistoricalImport: true,
    supportsDecisionComments: true,
    supportsReadOnlyTools: true,
    supportsInteractiveCommands: true,
    supportsProactiveNotifications: false,
  },
  cicd: {
    tier: 'cicd',
    supportsWebhooks: false,
    supportsTranscripts: false,
    supportsMultiDecision: false,
    supportsIssueCreation: false,
    supportsHistoricalImport: true,
    supportsDecisionComments: false,
    supportsReadOnlyTools: true,
    supportsInteractiveCommands: false,
    supportsProactiveNotifications: false,
  },
  observability: {
    tier: 'observability',
    supportsWebhooks: false,
    supportsTranscripts: false,
    supportsMultiDecision: false,
    supportsIssueCreation: false,
    supportsHistoricalImport: false,
    supportsDecisionComments: false,
    supportsReadOnlyTools: true,
    supportsInteractiveCommands: false,
    supportsProactiveNotifications: false,
  },
  intelligence: {
    tier: 'intelligence',
    supportsWebhooks: false,
    supportsTranscripts: false,
    supportsMultiDecision: false,
    supportsIssueCreation: false,
    supportsHistoricalImport: false,
    supportsDecisionComments: false,
    supportsReadOnlyTools: true,
    supportsInteractiveCommands: false,
    supportsProactiveNotifications: false,
  },
};

export function getTierCapabilities(tier: ConnectorTier): TierCapabilities {
  return TIER_CAPABILITIES[tier];
}

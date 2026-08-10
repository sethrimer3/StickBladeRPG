export const MAIN_CAMPAIGN_ID = 'STICKBLADE_CAMPAIGN';

let activeCampaignId = MAIN_CAMPAIGN_ID;

export function getActiveCampaignId(): string {
  return activeCampaignId;
}

export function setActiveCampaignId(campaignId: string): void {
  activeCampaignId = campaignId;
}

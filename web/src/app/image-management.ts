export const IMAGE_MANAGEMENT_TABS = ['images', 'registry', 'sources'] as const;
export type ImageManagementTab = typeof IMAGE_MANAGEMENT_TABS[number];

export const normalizeImageManagementTab = (value: string | null): ImageManagementTab =>
  IMAGE_MANAGEMENT_TABS.includes(value as ImageManagementTab) ? value as ImageManagementTab : 'images';

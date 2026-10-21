import { GROUP_FEATURES, type GroupDto, type GroupSettingsDto } from '@btx24/shared';

export function newGroup(): GroupSettingsDto {
  return {
    name: '',
    dealCategoryId: null,
    resourceIds: [],
    bookingMode: 'duration',
    durationMinutes: 60,
    checkInTime: '14:00',
    checkOutTime: '12:00',
    defaultNights: 1,
    techWindowMinutes: 0,
    features: [...GROUP_FEATURES],
    members: [],
  };
}

/** PUT принимает только настройки; options переносим целиком, без потери настроек прототипа. */
export function groupSettings(group: GroupDto): GroupSettingsDto {
  const { id: _id, sort: _sort, ...settings } = group;
  return structuredClone(settings);
}

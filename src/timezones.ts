const DEFAULT_TIMEZONE = 'UTC';

export function isValidTimeZone(timezone: string | null | undefined): timezone is string {
    if (!timezone || typeof timezone !== 'string') return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

export function normalizeTimeZone(timezone: string | null | undefined, fallback = DEFAULT_TIMEZONE): string {
    if (isValidTimeZone(timezone)) return timezone;
    return isValidTimeZone(fallback) ? fallback : DEFAULT_TIMEZONE;
}

export function getDateKeyInTimeZone(value: Date | string, timezone: string): string {
    const date = value instanceof Date ? value : new Date(value);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: normalizeTimeZone(timezone),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
    const month = parts.find((part) => part.type === 'month')?.value ?? '01';
    const day = parts.find((part) => part.type === 'day')?.value ?? '01';
    return `${year}-${month}-${day}`;
}

export function getTimePartsInTimeZone(value: Date | string, timezone: string): { hours: number; minutes: number; seconds: number } {
    const date = value instanceof Date ? value : new Date(value);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: normalizeTimeZone(timezone),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    return {
        hours: Number(parts.find((part) => part.type === 'hour')?.value ?? 0),
        minutes: Number(parts.find((part) => part.type === 'minute')?.value ?? 0),
        seconds: Number(parts.find((part) => part.type === 'second')?.value ?? 0),
    };
}

function getTimeZoneOffsetMs(timezone: string, date: Date): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: normalizeTimeZone(timezone),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);

    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second),
    );
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedDateTimeToUtc(
    dateKey: string,
    timezone: string,
    time: { hours?: number; minutes?: number; seconds?: number; milliseconds?: number } = {},
): Date {
    const [year, month, day] = dateKey.slice(0, 10).split('-').map(Number);
    const guessMs = Date.UTC(
        year,
        month - 1,
        day,
        time.hours ?? 0,
        time.minutes ?? 0,
        time.seconds ?? 0,
        time.milliseconds ?? 0,
    );
    const normalized = normalizeTimeZone(timezone);
    const firstPass = new Date(guessMs - getTimeZoneOffsetMs(normalized, new Date(guessMs)));
    return new Date(guessMs - getTimeZoneOffsetMs(normalized, firstPass));
}

export function getUtcDayBounds(dateKey: string | undefined, timezone: string, reference: Date = new Date()) {
    const normalized = normalizeTimeZone(timezone);
    const key = dateKey?.slice(0, 10) || getDateKeyInTimeZone(reference, normalized);
    const start = zonedDateTimeToUtc(key, normalized);
    const end = zonedDateTimeToUtc(key, normalized, { hours: 24 });
    return { start, end, dateKey: key, timezone: normalized };
}

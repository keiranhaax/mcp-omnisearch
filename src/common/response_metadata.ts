export interface ProviderResponseMetadata {
	request_id?: string;
	response_time_seconds?: number;
	usage?: { credits: number };
}

const response_metadata = new WeakMap<
	object,
	ProviderResponseMetadata
>();

const is_record = (
	value: unknown,
): value is Record<string, unknown> =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value);

const is_measurement = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const set_response_metadata = (
	result: object,
	raw: unknown,
): void => {
	if (!is_record(raw)) return;
	const metadata: ProviderResponseMetadata = {};
	if (
		typeof raw.request_id === 'string' &&
		/^[A-Za-z0-9_-]{1,128}$/.test(raw.request_id)
	) {
		metadata.request_id = raw.request_id;
	}
	if (is_measurement(raw.response_time)) {
		metadata.response_time_seconds = raw.response_time;
	}
	if (is_record(raw.usage) && is_measurement(raw.usage.credits)) {
		metadata.usage = { credits: raw.usage.credits };
	}
	if (Object.keys(metadata).length > 0) {
		response_metadata.set(result, metadata);
	}
};

export const get_response_metadata = (
	result: object,
): ProviderResponseMetadata | undefined =>
	response_metadata.get(result);

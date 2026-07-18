import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import * as v from 'valibot';
import { create_error_response } from '../../common/errors.js';
import {
	cleanup_expired_results,
	read_result_chunk,
	RESULT_READ_LIMIT,
} from '../../common/result_store.js';

export const register_result_read = (
	server: McpServer<GenericSchema>,
) => {
	cleanup_expired_results();
	server.tool(
		{
			name: 'result_read',
			description:
				'Read a paginated chunk from an oversized Omnisearch result using the opaque result_id returned by another tool. Results expire automatically.',
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			schema: v.object({
				result_id: v.pipe(
					v.string(),
					v.regex(
						/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
						'Invalid result ID',
					),
					v.description(
						'Opaque result ID returned by an Omnisearch tool',
					),
				),
				offset: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.description('One-based line offset (default: 1)'),
					),
				),
				limit: v.optional(
					v.pipe(
						v.number(),
						v.integer(),
						v.minValue(1),
						v.maxValue(RESULT_READ_LIMIT),
						v.description(
							`Maximum lines to return (default: 200, max: ${RESULT_READ_LIMIT})`,
						),
					),
				),
			}),
		},
		async ({ result_id, offset, limit }) => {
			try {
				const chunk = read_result_chunk(result_id, offset, limit);
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(chunk, null, 2),
						},
					],
				};
			} catch (error) {
				const body = create_error_response(error as Error);
				return {
					content: [{ type: 'text' as const, text: body.error }],
					isError: true,
				};
			}
		},
	);
};

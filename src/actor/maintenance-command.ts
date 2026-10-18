import {z} from 'zod';
const restoreId=z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),bookmark=z.string().min(1).max(512);
export const maintenanceCommandSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('status')}),z.strictObject({action:z.literal('pause')}),z.strictObject({action:z.literal('verify')}),
 z.strictObject({action:z.literal('resume'),reviewDigest:z.string().regex(/^[a-f0-9]{64}$/)}),
 z.strictObject({action:z.literal('bookmark'),at:z.iso.datetime().optional()}),
 z.strictObject({action:z.literal('restore'),bookmark,restoreId}),z.strictObject({action:z.literal('restart'),restoreId}),
]);
export type MaintenanceCommand=z.infer<typeof maintenanceCommandSchema>;

import {describe,expect,it,vi} from "vitest";
import {runConfirmedTrackerWrites} from "../src/services/streaming-tracker-write-queue.js";
describe("confirmed tracker write queue",()=>{
 it("executes writes sequentially and records successes",async()=>{const write=vi.fn(async()=>{});const result=await runConfirmedTrackerWrites([{externalId:"1",listId:1},{externalId:"2",listId:2}],write);expect(write).toHaveBeenCalledTimes(2);expect(result.succeeded).toHaveLength(2);expect(result.failed).toBeNull();});
 it("stops after the first failed write",async()=>{const write=vi.fn(async(op:{externalId:string})=>{if(op.externalId==="2")throw new Error("remote failed");});const result=await runConfirmedTrackerWrites([{externalId:"1",listId:1},{externalId:"2",listId:2},{externalId:"3",listId:3}],write);expect(write).toHaveBeenCalledTimes(2);expect(result.succeeded).toHaveLength(1);expect(result.failed?.externalId).toBe("2");});
 it("honors cancellation before the next write",async()=>{const controller=new AbortController();const write=vi.fn(async()=>{controller.abort();});const result=await runConfirmedTrackerWrites([{externalId:"1",listId:1},{externalId:"2",listId:2}],write,controller.signal);expect(write).toHaveBeenCalledTimes(1);expect(result.cancelled).toBe(true);});
});

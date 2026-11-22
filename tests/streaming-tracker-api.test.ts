import {describe,expect,it} from "vitest";
import {normalizeYummyLists} from "../src/services/streaming-tracker-api.js";
describe("YummyAnime tracker normalization",()=>{
 it("normalizes only rows with a recognized list label",()=>{const result=normalizeYummyLists({profile:{},lists:[{id:1,name:"Watching"},{id:2,name:"Completed"},{id:3,name:"Custom shelf"}],entries:[{anime_id:10,list_id:1,title:"One",episodes_watched:4},{anime_id:11,list_id:2,title:"Two",score:8},{anime_id:12,list_id:3,title:"Three"}],count:3});expect(result).toHaveLength(2);expect(result[0]?.entry.status).toBe("WATCHING");expect(result[0]?.entry.progress).toBe(4);expect(result[1]?.entry.status).toBe("COMPLETED");expect(result[1]?.entry.score).toBe(80);});
 it("skips malformed rows instead of inventing IDs or titles",()=>{expect(normalizeYummyLists({profile:{},lists:[{id:1,name:"Watching"}],entries:[{list_id:1,title:"No ID"},{anime_id:2,list_id:1}],count:2})).toEqual([]);});
});

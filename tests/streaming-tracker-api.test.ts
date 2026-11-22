import {describe,expect,it} from "vitest";
import {normalizeYummyLists} from "../src/services/streaming-tracker-api.js";
describe("YummyAnime tracker normalization",()=>{
 it("normalizes only rows with a recognized list label",()=>{const result=normalizeYummyLists({profile:{},lists:[{id:1,name:"Watching"},{id:2,name:"Completed"},{id:3,name:"Custom shelf"}],entries:[{anime_id:10,list_id:1,title:"One",episodes_watched:4},{anime_id:11,list_id:2,title:"Two",score:8},{anime_id:12,list_id:3,title:"Three"}],count:3});expect(result).toHaveLength(2);expect(result[0]?.entry.status).toBe("WATCHING");expect(result[0]?.entry.progress).toBe(4);expect(result[1]?.entry.status).toBe("COMPLETED");expect(result[1]?.entry.score).toBe(80);});
 it("recognizes flattened server rows with nested anime and user metadata",()=>{
  const result=normalizeYummyLists({profile:{},lists:[{id:0,name:"Смотрю"}],entries:[{
   list_id:0,
   anime:{anime_id:77,title:"Nested title",year:2025,poster:{huge:"https://img.example/poster.jpg"}},
   user:{rate:8,list:{progress:6,is_fav:true}},
  }],count:1});
  expect(result).toHaveLength(1);
  expect(result[0]?.anime).toMatchObject({id:"yummyanime:77",titles:{romaji:"Nested title"},year:2025,posterUrl:"https://img.example/poster.jpg"});
  expect(result[0]?.entry).toMatchObject({status:"WATCHING",progress:6,score:80,favorite:true});
 });
 it("maps full YummyAnime card metadata including nested poster, type, genres, rating and episode count",()=>{
  const result=normalizeYummyLists({profile:{},lists:[],entries:[{
   anime_id:31,title:"Card title",list_id:0,
   anime:{
    anime_id:31,title:"Card title",year:2024,
    poster:{huge:"//img.example/card.webp"},
    type:{name:"ТВ",shortname:"tv"},
    min_age:{value:5,title:"R+"},
    anime_status:{alias:"ongoing",title:"Онгоинг"},
    rating:{average:8.4},
    genres:[{title:"Фэнтези"},{title:"Приключения"}],
    episodes:{aired:8,count:12},
    remote_ids:{myanimelist_id:1234,shikimori_id:5678},
    original:"Original title",other_titles:["Alt title"],
   },
   user:{rating:9,list:{list:{id:0,title:"Смотрю"},is_fav:false}},
  }],count:1});
  expect(result).toHaveLength(1);
  expect(result[0]?.anime).toMatchObject({
   posterUrl:"https://img.example/card.webp",format:"TV",ageRating:"R+",
   releaseStatus:"ONGOING",averageScore:8.4,genres:["Фэнтези","Приключения"],
   episodes:12,year:2024,externalIds:{yummyanime:"31",myanimelist:"1234",shikimori:"5678"},
   titles:{synonyms:["Original title","Alt title"]},
  });
  expect(result[0]?.entry.score).toBe(90);
 });
 it("treats zero user and catalog ratings as not rated",()=>{
  const result=normalizeYummyLists({profile:{},lists:[],entries:[{
   anime_id:32,title:"Unrated",list_id:1,rating:{average:0},
   user:{rating:0,list:{list:{id:1,title:"Смотрю"}}},
  }],count:1});
  expect(result).toHaveLength(1);
  expect(result[0]?.anime.averageScore).toBeUndefined();
  expect(result[0]?.entry.score).toBeNull();
  expect(result[0]?.entry.sourceMetadata?.scoreKnown).toBe(false);
 });
 it("does not guess statuses from numeric IDs when list labels are unknown",()=>{
  const result=normalizeYummyLists({profile:{},lists:[{id:3,name:"Custom shelf"}],entries:[
   {anime_id:21,list_id:3,title:"Custom list entry"},
  ],count:1});
  expect(result).toEqual([]);
 });
 it("marks omitted source fields as unknown so imports can preserve prior values",()=>{const result=normalizeYummyLists({profile:{},lists:[{id:1,name:"Watching"}],entries:[{anime_id:9,list_id:1,title:"Unknown fields"}],count:1});expect(result[0]?.entry.sourceMetadata).toEqual({progressKnown:false,scoreKnown:false,favoriteKnown:false});});
 it("skips malformed rows instead of inventing IDs or titles",()=>{expect(normalizeYummyLists({profile:{},lists:[{id:1,name:"Watching"}],entries:[{list_id:1,title:"No ID"},{anime_id:2,list_id:1}],count:2})).toEqual([]);});
});

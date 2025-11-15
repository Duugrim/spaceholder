```
shotResult:
{
	shotPaths: 
	[
		{
		    id: 0,
		    type: "line",
		    start: { x: 100, y: 300 },
		    end: { x: 150, y: 290 }
	    },
	    {
		    id: 1,
		    type: "line", 
		    start: { x: 150, y: 290 },
		    end: { x: 200, y: 270 }
	    },
	    {
		    id: 2,
		    type: "line",
		    start: { x: 200, y: 270 },
		    end: { x: 250, y: 240 }
	    },
	    {
		    id: 3,
		    type: "circle",
			range: 50,
			start: { x: 250, y: 240 },
		    end: { x: 250, y: 240 }
		}
	],
	shotHits: 
	[
		{
			id: 1,
			hitSegment: 3, //id сегмента, в котором произошло столкновение
			result: 
			{
				grade: 1, //0 = промах, 1 = задел, 2 = попал, 3 = крит
				damage: [],
				token: token1, //объект, в который попали
				path: 0, //0 = без изменений, 1 = отклонение, 2 = рикошет, 3 = стоп
				direct: true
			}
		},
		{
			id: 2,
			hitSegment: 4, //id сегмента, в котором произошло столкновение
			result: 
			{
				grade: 2, //0 = промах, 1 = задел, 2 = попал, 3 = крит
				damage: [],
				token: token2, //объект, в который попали
				path: 0, //0 = без изменений, 1 = отклонение, 2 = рикошет, 3 = стоп
				direct: false
			}
		},
		{
			id: 3,
			hitSegment: 4, //id сегмента, в котором произошло столкновение
			result: 
			{
				grade: 2, //0 = промах, 1 = задел, 2 = попал, 3 = крит
				damage: [],
				token: token3, //объект, в который попали
				path: 0, //0 = без изменений, 1 = отклонение, 2 = рикошет, 3 = стоп
				direct: false
			}
		}
	]
}
```
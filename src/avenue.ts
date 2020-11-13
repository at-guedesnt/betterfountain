import * as vscode from "vscode";
import { getEditor } from "./extension";

const helpers={

    bisectLeft: function(a:any[], x:number, propname:any, lo?:number, hi?:number) {
        if (lo == null) lo = 0;
        if (hi == null) hi = a.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (a[propname] - x < 0) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      },
    bisectRight:function(a:any[], x:number, propname:any, lo?:number, hi?:number) {
        if (lo == null) lo = 0;
        if (hi == null) hi = a.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (a[propname] - x > 0) hi = mid;
          else lo = mid + 1;
        }
        return lo;
      }
    
}

const regex: { [index: string]: RegExp } = {
    title_page: /(title|credit|author[s]?|source|notes|draft date|date|watermark|contact|copyright|font)\:.*/i,

    section: /^[ \t]*(#+)(?: *)(.*)/,
    synopsis: /^[ \t]*(?:\=(?!\=+) *)(.*)/,

    scene_heading: /^[ \t]*([.](?=[0-9a-z])|(?:[*]{0,3}_?)(?:int|ext|est|int[.]?\/ext|i[.]?\/e)[. ])(.+?)(#[-.0-9a-z]+#)?$/i,
    scene_number: /#(.+)#/,

    transition: /^[ \t]*((?:FADE (?:TO BLACK|OUT)|CUT TO BLACK)\.|.+ TO\:|^TO\:$)|^(?:> *)(.+)/,

    dialogue: /^[ \t]*([*_]+[0-9\p{Lu} (._\-'’)]*)(\^?)?(?:\n(?!\n+))([\s\S]+)/u,

    character: /^[ \t]*(([\p{Lu}0-9- \.#]+(\([A-z0-9 '’\-.()]+\))*|(@.*))(\s*\^)?$)/u,
    parenthetical: /^[ \t]*(\(.+\))$/,

    action: /^(.+)/g,
    centered: /^[ \t]*(?:> *)(.+)(?: *<)(\n.+)*/g,

    page_break: /^\={3,}$/,
    line_break: /^ {2}$/,

    note_inline: /(?:\[{2}(?!\[+))([\s\S]+?)(?:\]{2}(?!\[+))/g,

    emphasis: /(_|\*{1,3}|_\*{1,3}|\*{1,3}_)(.+)(_|\*{1,3}|_\*{1,3}|\*{1,3}_)/g,
    bold_italic_underline: /(_{1}\*{3}(?=.+\*{3}_{1})|\*{3}_{1}(?=.+_{1}\*{3}))(.+?)(\*{3}_{1}|_{1}\*{3})/g,
    bold_underline: /(_{1}\*{2}(?=.+\*{2}_{1})|\*{2}_{1}(?=.+_{1}\*{2}))(.+?)(\*{2}_{1}|_{1}\*{2})/g,
    italic_underline: /(?:_{1}\*{1}(?=.+\*{1}_{1})|\*{1}_{1}(?=.+_{1}\*{1}))(.+?)(\*{1}_{1}|_{1}\*{1})/g,
    bold_italic: /(\*{3}(?=.+\*{3}))(.+?)(\*{3})/g,
    bold: /(\*{2}(?=.+\*{2}))(.+?)(\*{2})/g,
    italic: /(\*{1}(?=.+\*{1}))(.+?)(\*{1})/g,
    lyric: /^(\~.+)/g,
    underline: /(_{1}(?=.+_{1}))(.+?)(_{1})/g,
};

/**
 * Preprocess:    calculate which tokens need to be removed and where the new ones should be added
 * Parse:         Parse whatever needs to be parsed
 * Apply:         update, remove, or insert new tokens
 * Idle:          no ongoing operations
 */
export enum ParseState { Preprocess = "preprocess", Parse = "parse", Apply="apply", Idle = "idle" }

export enum TokenType { TitlePage, Section, Synopse, SceneHeading, Action, Character, Dialogue, Parenthetical, Lyric, Transition, CenteredText, PageBreak, Seperator }

/** The tokens used by avenue. Each token start at a new line */
type AvenueToken = {
    /** The offset at which the token appears, from the beginning of the document. Unique - can be used as a token 'id' */
    offset:number,
    /** The type of the token */
    type:TokenType,
    /** The exact text contained within the token */
    textReal:string,
    /** The text as it appears once printed (=trimmed, without any markdown indicators, etc...) */
    textVisible:string,
    /**  0=no dual dialogue, 1= to the left, 2= to the right */
    dualDialogue:number
    /** The depth of the item, 0 being root */
    depth:number
}

const staleRange = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255,50,50,0.5)',
    isWholeLine:true
  });

/** A high-performance and feature-rich incremental foutain parser */
export class parser {
    constructor() {
        
    }
    tokens:AvenueToken[]
    /** Arrays for each token type's indexes */
    tokenIndexes:{
        TitlePage:number[], 
        Section:number[],
        Synopse:number[],
        SceneHeading:number[],
        Dialogue:number[]
    }

    public stateChanged: (state:ParseState) => void;
    private _state:ParseState
    get state(){ return this._state}
    set state(val)
    {
        if(this._state != ParseState.Idle) console.timeEnd("Parsing state '" + this._state + "'");
        this._state = val; 
        this.stateChanged(val);
        if(val != ParseState.Idle) console.time("Parsing state '" + val + "'");
    }

    /** Parse only the required part of the document based on a set of changes */
    public parseChanges(change:vscode.TextDocumentChangeEvent){

        //////////////////////////////////////////
        /// FIGURE OUT WHAT NEEDS TO BE PARSED ///
        //////////////////////////////////////////

        this.state = ParseState.Preprocess;

        let startParse = 0; //the offset after which the new text should be parsed, and after which old tokens are stale
        let endParse = 0; //the offset until which the new text should be parsed
        let endStale = 0; //the offset until which the old tokens are stale
        let newtextLength = 0;
        let removedTextLength = 0;
        for (let i = 0; i < change.contentChanges.length; i++) {
            let cc = change.contentChanges[i];
            newtextLength+=cc.text.length;
            removedTextLength+=cc.rangeLength;
            if(i==0){
                startParse = cc.rangeOffset;
                endParse = cc.rangeOffset+cc.text.length;
                endStale = cc.rangeOffset+cc.rangeLength;
            }
            else{
                if(startParse > cc.rangeOffset) startParse = cc.rangeOffset;
                if(endParse < cc.rangeOffset+cc.text.length) endParse = cc.rangeOffset+cc.text.length;
                if(endStale<cc.rangeOffset+cc.rangeLength) endStale = cc.rangeOffset+cc.rangeLength;
            }
        }
        let textlengthDelta = newtextLength - removedTextLength;
        console.log("editing delta is ="+textlengthDelta);
        
        let documentText = change.document.getText();

        //move the startStale offset back to the previous empty line
        let prevNewLineCounter = 0;
        while(prevNewLineCounter<2 && startParse > 0){
            if(documentText[startParse] == '\n')
                prevNewLineCounter++;
            else if(documentText[startParse] != '\r')
                prevNewLineCounter = 0;
            startParse--;
        }
        //and now continue moving back until we hit a non-linebreak
        var isCRLF = false;
        while(startParse > 0){
            if(documentText[startParse] == '\r') isCRLF = true;
            else if(documentText[startParse] != '\n' && documentText[startParse] != '\r') break;
            startParse--;
        }
        startParse+=2;
        if(isCRLF) startParse++;

        //move the endStale offset towards the next empty line
        let nextNewLineCounter = 0;
        while(nextNewLineCounter<2 && endParse < documentText.length){
            if(documentText[endParse] == '\n')
                nextNewLineCounter++;
            else if(documentText[endParse] != '\r')
                nextNewLineCounter = 0;
            endParse++;
        }
        //and now continue moving forward until we hit a non-linebreak
        while(endParse<documentText.length){
            if(documentText[endParse] != '\n' && documentText[endParse] != '\r') break;
            endParse++;
        }
        endParse--;
        
        this.state = ParseState.Idle; 

        //find the index of the tokens which should be removed
        let staleIndexStart = helpers.bisectRight(this.tokens, startParse, "offset");
        let staleIndexEnd = helpers.bisectLeft(this.tokens, endStale, "offset");
        let staleLength = staleIndexEnd-staleIndexStart;

        //remove any references to these old tokens
        this.clearReferences(staleIndexStart, staleIndexEnd);

        //get the new tokens
        let newtokens = this.getTokens(documentText, startParse);

        if(staleIndexEnd == this.tokens.length-1){
            //We're inserting at the very end, we can just push the new tokens after the existing ones
            for (let i = 0; i < newtokens.length; i++) {
                this.tokens[staleIndexStart+i] = newtokens[i];
            }
        }
        if(staleLength == newtokens.length){
            //There's the same amount of old tokens as there is new ones. Just replace the old with the new, and then update the rest
            for (let i = 0; i < newtokens.length; i++) {
                this.tokens[staleIndexEnd+i] = newtokens[i];
            }
            if(textlengthDelta!=0){
                //if it were 0, then the offset of all these tokens wouldn't have changed
                for(let i = staleIndexEnd+1; i < this.tokens.length; i++){
                    this.tokens[i].offset = this.tokens[i].offset + textlengthDelta
                    this.updateReference(i);
                }
            }
        }
        else if(staleIndexEnd == this.tokens.length-1){
            //We can just push the new tokens at the end of the tokens array. Speed=O(newtokens.length)

        }
        else{
            //We need to insert the new tokens in the middle of an existing array. Speed=O(newtokens.length+this.tokens.length)
            this.tokens.splice(staleIndexStart, staleLength, ...newtokens);
        }


        this.parseRange(startParse,endParse, change.document);

        
    }

    private getTokens(input:string, startoffset:number):AvenueToken[]{
        console.log("Getting tokens starting at " + startoffset + " of length " + input.length);
        let result:AvenueToken[] = [];
        return result;
    }

    private updateReference(index:number){
        //TODO
        console.log("updating reference " + index);
    }
    private clearReferences(start:number, end:number){
        for (let i = start; i <= end; i++) {
            let offset = this.tokens[i].offset;
            console.log("remove " + offset);
            //Remove any reference to this token
        }
    }

    private parseRange(start:number, end:number, doc:vscode.TextDocument){
        getEditor(doc.uri).setDecorations(staleRange, [new vscode.Range(doc.positionAt(start), doc.positionAt(end))]);

        //how long does it take to go through the entire file, character by character?
        console.time("drivethrough");
        let text = doc.getText();
        let tl = text.length-1;
        let wcounter = 0;
        while(tl!=0){
            if(text[tl] == "\n") wcounter++;
            tl--;
        }
        console.timeEnd("drivethrough");
        console.log(wcounter + "new lines");
        let token:AvenueToken;
        token;
    }

    /** Parse the entire document */
    public parseDocument(document:vscode.TextDocument){
        console.log(document.fileName);
        console.log(regex);
    }
}
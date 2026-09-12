/**
 * Telling maths from a dollar sign that happened to be there twice.
 *
 * A shell prompt ends in `$`, and a pasted terminal session has two of them.
 * `remark-math` pairs those up and hands everything between them to KaTeX as
 * one expression — so a thousand characters of `dmesg` output came out set in
 * italic serif, and took about a second to do it, because KaTeX lays out every
 * glyph of an "equation" into its own nest of spans. `$$` is the same story:
 * in a shell script it is the process id, and two of those bracket the script.
 *
 * What tells the two apart is shape rather than content. Real inline maths is
 * short and sits within a line; real display maths is a formula rather than a
 * document. Anything past those bounds is put back as the literal text it
 * always was — which is both what it should have looked like and free to draw.
 *
 * Being wrong in this direction costs a reader the typesetting of one unusually
 * long formula, and they still see exactly what they wrote. Being wrong in the
 * other direction is a screenful of nonsense that takes a second to arrive.
 */

/** Held here rather than inlined so the tests can say what they are testing. */
export const LONGEST_INLINE_MATH = 160
export const LONGEST_BLOCK_MATH = 600

/** As much of an mdast node as this needs to know about. */
export interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

/** Whether a run `remark-math` found is plausibly maths at all. */
export function isPlausibleMath(node: MdastNode): boolean {
  const value = node.value ?? ''
  if (node.type === 'inlineMath') {
    // The newline is the stronger half of this test by far: almost every
    // false positive in practice is a fragment of shell spanning lines.
    return value.length <= LONGEST_INLINE_MATH && !value.includes('\n')
  }
  if (node.type === 'math') return value.length <= LONGEST_BLOCK_MATH
  return true
}

/**
 * A remark plugin, to run *after* `remark-math` and on what it made.
 *
 * Replaces each implausible run with the source text it was parsed from. A
 * `math` node is always a block, so a paragraph is always allowed where one
 * stood; an `inlineMath` node sits among text, so text is what replaces it.
 */
export function remarkOnlyPlausibleMath() {
  return (tree: MdastNode): void => {
    const walk = (node: MdastNode): void => {
      const children = node.children
      if (!children) return

      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (isPlausibleMath(child)) {
          walk(child)
          continue
        }

        const value = child.value ?? ''
        children[i] =
          child.type === 'inlineMath'
            ? { type: 'text', value: `$${value}$` }
            : { type: 'paragraph', children: [{ type: 'text', value: `$$${value}$$` }] }
      }
    }

    walk(tree)
  }
}

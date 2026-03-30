import OM_SpecialClass from "../OM/OM_SpecialClass";

/**
 * CHAIR mirror of OM_SpecialClass.
 * - Same UI/data/actions/rendering as OM.
 * - CHAIR-only difference: cannot set the submission deadline; can only view it.
 */
export default function CHAIR_SpecialClass() {
  return <OM_SpecialClass deadlineReadOnly role="chair" />;
}

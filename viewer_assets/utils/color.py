from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Module-level collection for unresolved objects (for batch logging)
# NOTE: This is cleared after each log_unresolved_summary() call
_unresolved_objects: List[str] = []


def clear_color_cache() -> None:
    """Clear module-level caches to prevent memory leaks between processing runs.
    
    Call this after processing is complete to ensure clean state.
    """
    global _unresolved_objects
    _unresolved_objects.clear()


# ============================================================================
# Internal Utilities
# ============================================================================

def is_default_material(mat_name: str, rgba: Tuple[float, float, float, float], obj_type: Optional[str] = None, transparency: float = 0.0) -> bool:
    """Detect if material is a generic default (gray 0.45-0.95 + generic name).
    
    Checks:
    - Color: neutral gray in 0.45-0.95 range
    - Name: 'default'/'unnamed'/'unknown' or matches IFC type
    - Transparency: materials with transparency > 0 are NOT defaults
    
    Returns:
        True if material appears to be a default placeholder
    """
    # Skip materials with transparency - they have real color data
    if transparency > 0.01:
        return False
    
    # Check color: neutral gray in 0.45-0.95 range
    r, g, b = rgba[:3]
    is_gray = abs(r - g) < 0.05 and abs(g - b) < 0.05
    is_default_gray = is_gray and 0.45 <= r <= 0.95
    
    if not is_default_gray:
        return False
    
    # If color is default gray, check if name also indicates default
    if not mat_name:
        return True
    
    mat_lower = mat_name.lower()
    
    # Generic default keywords
    if any(kw in mat_lower for kw in ['default', 'unnamed', 'unknown']):
        return True
    
    # Material name matches object's IFC type (e.g., "IfcWall" for IfcWall)
    if obj_type and obj_type.lower() in mat_lower:
        return True
    
    # Generic IFC type pattern: IfcXxx (CamelCase)
    if mat_lower.startswith('ifc') and len(mat_name) > 3 and mat_name[3].isupper():
        return True
    
    return False

def _parse_surface_color(surface_style: Any) -> Optional[Dict[str, Any]]:
    """Extract color from IfcSurfaceStyleRendering/Shading.
    
    Returns dict with material_name, rgba, transparency, or None if fails.
    """
    try:
        if not (surface_style.is_a('IfcSurfaceStyleRendering') or surface_style.is_a('IfcSurfaceStyleShading')):
            return None
        
        if not hasattr(surface_style, 'SurfaceColour') or not surface_style.SurfaceColour:
            return None
        
        c = surface_style.SurfaceColour
        r = float(getattr(c, 'Red', 0.5))
        g = float(getattr(c, 'Green', 0.5))
        b = float(getattr(c, 'Blue', 0.5))
        t = float(getattr(surface_style, 'Transparency', 0.0) or 0.0)
        a = max(0.0, min(1.0, 1.0 - t))
        
        name = None
        for nm in ['Name', 'name']:
            if hasattr(c, nm) and getattr(c, nm):
                name = str(getattr(c, nm))
                break
        
        return {
            'material_name': name,
            'rgba': (r, g, b, a),
            'transparency': t
        }
    except Exception:
        return None


def _parse_ifc_styles(styles_collection: Any, callback) -> None:
    """Parse IFC4/IFC2x3 Styles collections uniformly.
    
    Handles direct IfcSurfaceStyle (IFC4) and nested IfcPresentationStyleAssignment (IFC2x3).
    """
    for style_or_assignment in styles_collection:
        if style_or_assignment.is_a('IfcSurfaceStyle'):
            # IFC4: Direct IfcSurfaceStyle
            for sub in getattr(style_or_assignment, 'Styles', []) or []:
                callback(sub)
        elif hasattr(style_or_assignment, 'Styles'):
            # IFC2x3: IfcPresentationStyleAssignment with nested Styles
            for style in getattr(style_or_assignment, 'Styles', []) or []:
                if style.is_a('IfcSurfaceStyle'):
                    for sub in getattr(style, 'Styles', []) or []:
                        callback(sub)


def extract_color_from_material(material: Any) -> Tuple[float, float, float, float, float, str]:
    """Extract RGBA and transparency from ifcopenshell material/style object.
    
    Handles: NaN transparency, 0-100 scale normalization, missing diffuse color.
    
    Returns:
        Tuple of (r, g, b, alpha, transparency, material_name)
    """
    r, g, b = 0.5, 0.5, 0.5
    
    if hasattr(material, 'diffuse'):
        diffuse = material.diffuse
        if hasattr(diffuse, 'r') and hasattr(diffuse, 'g') and hasattr(diffuse, 'b'):
            r = float(diffuse.r())
            g = float(diffuse.g())
            b = float(diffuse.b())
    
    # Handle transparency with NaN and None checks
    raw_transparency = getattr(material, 'transparency', 0.0)
    
    # Handle None and NaN
    if raw_transparency is None or (isinstance(raw_transparency, float) and math.isnan(raw_transparency)):
        t = 0.0  # Default to opaque
    else:
        t = float(raw_transparency)
        # Detect if transparency is in 0-100 range instead of 0-1
        if t > 1.0:
            t = t / 100.0
    
    a = max(0.0, min(1.0, 1.0 - t))
    
    mat_name = str(getattr(material, 'name', 'Unnamed'))
    
    return r, g, b, a, t, mat_name


# ============================================================================
# Public API
# ============================================================================

def build_style_and_colour_indexes(ifc_model: Any) -> Tuple[Dict[int, List[Any]], Dict[int, Dict[str, Any]]]:
    styled_by_item: Dict[int, List[Any]] = {}
    try:
        for si in ifc_model.by_type('IfcStyledItem'):
            try:
                item = getattr(si, 'Item', None)
                if item is not None and hasattr(item, 'id') and callable(getattr(item, 'id')):
                    styled_by_item.setdefault(int(item.id()), []).append(si)
            except Exception:
                continue
    except Exception:
        pass

    indexed_colour_by_item: Dict[int, Dict[str, Any]] = {}
    try:
        for icm in ifc_model.by_type('IfcIndexedColourMap'):
            try:
                mapped_to = getattr(icm, 'MappedTo', None)
                colors = getattr(icm, 'Colors', None)
                if mapped_to is None or colors is None:
                    continue
                colour_list = getattr(colors, 'ColourList', None) or getattr(colors, 'ColorList', None)
                if colour_list is None:
                    continue
                r_sum = g_sum = b_sum = 0.0
                n = 0
                for triple in colour_list:
                    try:
                        r_sum += float(triple[0]); g_sum += float(triple[1]); b_sum += float(triple[2])
                        n += 1
                    except Exception:
                        continue
                if n > 0 and hasattr(mapped_to, 'id') and callable(getattr(mapped_to, 'id')):
                    r = r_sum / n; g = g_sum / n; b = b_sum / n
                    indexed_colour_by_item[int(mapped_to.id())] = {
                        'material_name': None,
                        'rgba': (r, g, b, 1.0),
                        'transparency': 0.0,
                    }
            except Exception:
                continue
    except Exception:
        pass

    # Log results
    logger.info("[COLOR_INDEX] IfcStyledItem found: %d item mappings", len(styled_by_item))
    logger.info("[COLOR_INDEX] IfcIndexedColourMap found: %d color maps (IFC4 feature)", len(indexed_colour_by_item))

    if styled_by_item:
        logger.debug("[COLOR_INDEX] Sample styled_by_item IDs: %s", list(styled_by_item.keys())[:3])
    if indexed_colour_by_item:
        logger.debug("[COLOR_INDEX] Sample indexed_colour_by_item IDs: %s", list(indexed_colour_by_item.keys())[:3])

    return styled_by_item, indexed_colour_by_item


def collect_styled_colors_from_obj(obj: Any, styled_by_item: Dict[int, List[Any]], indexed_colour_by_item: Dict[int, Dict[str, Any]]):
    """Extract styled colors from object's representation (IfcStyledItem, IfcIndexedColourMap)."""
    global_id = getattr(obj, 'GlobalId', 'Unknown')
    logger.debug("[STYLED_COLOR] Processing object: %s", global_id)
    
    styled_colors: List[Dict[str, Any]] = []

    def push_from_surface_style(surface_style) -> None:
        """Add color from surface style to styled_colors list."""
        color_dict = _parse_surface_color(surface_style)
        if color_dict:
            styled_colors.append(color_dict)

    def collect_from_item(item) -> None:
        try:
            if item.is_a('IfcStyledItem'):
                styles_attr = getattr(item, 'Styles', []) or []
                _parse_ifc_styles(styles_attr, push_from_surface_style)
            
            try:
                if hasattr(item, 'id') and callable(getattr(item, 'id')):
                    for styled in styled_by_item.get(int(item.id()), []) or []:
                        collect_from_item(styled)
            except Exception:
                pass
            
            if hasattr(item, 'StyledByItem') and item.StyledByItem:
                for styled in item.StyledByItem:
                    collect_from_item(styled)
            
            if hasattr(item, 'Styles') and item.Styles:
                _parse_ifc_styles(item.Styles, push_from_surface_style)
            
            if item.is_a('IfcMappedItem'):
                # IfcMappedItem -> MappingSource -> MappedRepresentation
                mapping_source = getattr(item, 'MappingSource', None)
                if mapping_source:
                    mapped = getattr(mapping_source, 'MappedRepresentation', None)
                    if mapped and getattr(mapped, 'Items', None):
                        for sub_item in mapped.Items:
                            collect_from_item(sub_item)
            
            try:
                if hasattr(item, 'id') and callable(getattr(item, 'id')):
                    icm = indexed_colour_by_item.get(int(item.id()))
                    if icm is not None:
                        styled_colors.append(dict(icm))
            except Exception:
                pass
        except Exception:
            return

    try:
        if hasattr(obj, 'Representation') and obj.Representation and hasattr(obj.Representation, 'Representations'):
            rep_count = len(obj.Representation.Representations or [])
            logger.debug("[STYLED_COLOR] %s: %d Representations found", global_id, rep_count)
            for i, rep in enumerate(obj.Representation.Representations or []):
                if hasattr(rep, 'Items') and rep.Items:
                    logger.debug("[STYLED_COLOR] %s: Rep[%d] has %d items", global_id, i, len(rep.Items))
                    for item in rep.Items:
                        item_type = item.is_a() if hasattr(item, 'is_a') else 'Unknown'
                        logger.debug("[STYLED_COLOR] %s: Processing item type: %s", global_id, item_type)
                        collect_from_item(item)
    except Exception:
        pass

    try:
        for type_rel in getattr(obj, 'IsTypedBy', []) or []:
            rtype = getattr(type_rel, 'RelatingType', None)
            if rtype and hasattr(rtype, 'RepresentationMaps') and rtype.RepresentationMaps:
                for rmap in rtype.RepresentationMaps or []:
                    mapped_rep = getattr(rmap, 'MappedRepresentation', None)
                    if mapped_rep and hasattr(mapped_rep, 'Items') and mapped_rep.Items:
                        for item in mapped_rep.Items:
                            collect_from_item(item)
    except Exception:
        pass

    logger.debug("[STYLED_COLOR] %s: Found %d styled colors", global_id, len(styled_colors))
    if styled_colors:
        for i, sc in enumerate(styled_colors[:3]):
            logger.debug("[STYLED_COLOR] %s: Color[%d] = RGBA%s, mat=%s", global_id, i, sc['rgba'], sc.get('material_name'))

    return styled_colors


def _extract_material_colors_unified(material: Any) -> List[Dict[str, Any]]:
    colors: List[Dict[str, Any]] = []
    materials_to_check: List[Any] = []
    try:
        if material is None:
            return colors
        if material.is_a('IfcMaterial'):
            materials_to_check.append(material)
        elif material.is_a('IfcMaterialLayerSetUsage') and getattr(material, 'ForLayerSet', None):
            for layer in getattr(material.ForLayerSet, 'MaterialLayers', []) or []:
                if hasattr(layer, 'Material') and layer.Material:
                    materials_to_check.append(layer.Material)
        elif material.is_a('IfcMaterialLayerSet'):
            for layer in getattr(material, 'MaterialLayers', []) or []:
                if hasattr(layer, 'Material') and layer.Material:
                    materials_to_check.append(layer.Material)
        elif material.is_a('IfcMaterialProfileSet'):
            for profile in getattr(material, 'MaterialProfiles', []) or []:
                if hasattr(profile, 'Material') and profile.Material:
                    materials_to_check.append(profile.Material)
        elif material.is_a('IfcMaterialConstituentSet'):
            for constituent in getattr(material, 'MaterialConstituents', []) or []:
                if hasattr(constituent, 'Material') and constituent.Material:
                    materials_to_check.append(constituent.Material)
        elif material.is_a('IfcMaterialList'):
            for mat in getattr(material, 'Materials', []) or []:
                materials_to_check.append(mat)

        for mat in materials_to_check:
            mat_name = getattr(mat, 'Name', 'Unnamed')
            
            for mat_def_rep in getattr(mat, 'HasRepresentation', []) or []:
                if mat_def_rep.is_a('IfcMaterialDefinitionRepresentation'):
                    for representation in getattr(mat_def_rep, 'Representations', []) or []:
                        if representation.is_a('IfcStyledRepresentation'):
                            for item in getattr(representation, 'Items', []) or []:
                                if item.is_a('IfcStyledItem'):
                                    styles_attr = getattr(item, 'Styles', []) or []
                                    
                                    def add_color_for_material(surface_style):
                                        """Add color with material name."""
                                        color_dict = _parse_surface_color(surface_style)
                                        if color_dict:
                                            # Convert to material color format
                                            colors.append({
                                                'material_name': mat_name,
                                                'color': {
                                                    'red': color_dict['rgba'][0],
                                                    'green': color_dict['rgba'][1],
                                                    'blue': color_dict['rgba'][2],
                                                    'transparency': color_dict['transparency'],
                                                },
                                            })
                                    
                                    _parse_ifc_styles(styles_attr, add_color_for_material)
    except Exception:
        pass
    return colors


def get_object_material_colors(obj: Any) -> List[Dict[str, Any]]:
    """Extract colors from object's material associations (HasAssociations, IsTypedBy).
    
    Handles IfcMaterialLayerSetUsage with DirectionSense layer selection.
    """
    global_id = getattr(obj, 'GlobalId', 'Unknown')
    logger.debug("[MATERIAL_COLOR] Processing object: %s", global_id)
    
    collected: List[Dict[str, Any]] = []
    
    def _extract_from_material(material: Any) -> List[Dict[str, Any]]:
        """Extract colors from material with special layer set handling."""
        if material is None:
            return []
        
        mat_type = material.is_a() if hasattr(material, 'is_a') else 'Unknown'
        logger.debug("[MATERIAL_COLOR] %s: Material type: %s", global_id, mat_type)
        
        # Special handling for IfcMaterialLayerSetUsage
        if material.is_a('IfcMaterialLayerSetUsage'):
            try:
                layer_set = getattr(material, 'ForLayerSet', None)
                direction_sense = getattr(material, 'DirectionSense', None)
                logger.debug("[MATERIAL_COLOR] %s: DirectionSense=%s (IFC4 layer selection)", global_id, direction_sense)
                
                if layer_set and hasattr(layer_set, 'MaterialLayers'):
                    layers = layer_set.MaterialLayers
                    if layers:
                        # Select visible layer: NEGATIVE = last layer, POSITIVE = first layer
                        if direction_sense == 'NEGATIVE':
                            visible_layer = layers[-1]
                            logger.debug("[MATERIAL_COLOR] %s: Selected LAST layer (NEGATIVE sense)", global_id)
                        else:
                            visible_layer = layers[0]
                            logger.debug("[MATERIAL_COLOR] %s: Selected FIRST layer (POSITIVE sense)", global_id)
                        
                        # Extract color from the visible layer's material
                        if hasattr(visible_layer, 'Material') and visible_layer.Material:
                            colors = _extract_material_colors_unified(visible_layer.Material)
                            if colors:
                                return colors
                
                # Fallback: if we couldn't get color from visible layer, try all layers
                return _extract_material_colors_unified(material)
            except Exception:
                # If anything fails, fallback to normal extraction
                return _extract_material_colors_unified(material)
        else:
            # For non-layer materials, use standard extraction
            return _extract_material_colors_unified(material)
    
    try:
        associations_count = len(getattr(obj, 'HasAssociations', []) or [])
        logger.debug("[MATERIAL_COLOR] %s: HasAssociations count: %d", global_id, associations_count)
        
        for association in getattr(obj, 'HasAssociations', []) or []:
            try:
                if association.is_a('IfcRelAssociatesMaterial'):
                    collected.extend(_extract_from_material(association.RelatingMaterial))
            except Exception:
                continue
        if not collected:
            logger.debug("[MATERIAL_COLOR] %s: No direct material, checking IsTypedBy...", global_id)
            for type_rel in getattr(obj, 'IsTypedBy', []) or []:
                rtype = getattr(type_rel, 'RelatingType', None)
                if rtype:
                    for association in getattr(rtype, 'HasAssociations', []) or []:
                        try:
                            if association.is_a('IfcRelAssociatesMaterial'):
                                collected.extend(_extract_from_material(association.RelatingMaterial))
                        except Exception:
                            continue
    except Exception:
        pass
    
    logger.debug("[MATERIAL_COLOR] %s: Found %d material colors", global_id, len(collected))
    if collected:
        for i, mc in enumerate(collected[:3]):
            col = mc.get('color', {})
            logger.debug(
                "[MATERIAL_COLOR] %s: Color[%d] = RGB(%s, %s, %s), mat=%s",
                global_id, i, col.get('red'), col.get('green'), col.get('blue'), mc.get('material_name'),
            )
    
    return collected


def resolve_colors_for_groups(
    groups: List[Dict[str, Any]],
    obj: Any,
    styled_by_item: Dict[int, List[Any]],
    indexed_colour_by_item: Dict[int, Dict[str, Any]],
    global_id: str
) -> None:
    """Refine default gray materials with IFC-defined colors.
    
    Strategy:
    1. Match by styled color names (IfcStyledItem)
    2. Match by material association names (IfcRelAssociatesMaterial)  
    3. Single-material fallback (1 group + 1 IFC material → apply directly)
    
    Updates groups in-place. Unmatched groups remain unchanged.
    Collects unresolved objects for batch logging.
    """
    if not groups:
        return
    
    # Get object type for default detection
    obj_type = obj.is_a() if obj and hasattr(obj, 'is_a') else None
    
    # Find groups with default gray colors (excluding transparent materials)
    unresolved_groups = [
        grp for grp in groups 
        if is_default_material(grp.get('material_name', ''), grp['rgba'], obj_type, grp.get('transparency', 0.0))
    ]
    
    if not unresolved_groups:
        return
    
    logger.debug("[COLOR_FIX_TRY] %s: %d/%d groups need color resolution", global_id, len(unresolved_groups), len(groups))
    
    # STRATEGY 1: Match by styled color names
    styled_palette = collect_styled_colors_from_obj(obj, styled_by_item, indexed_colour_by_item)
    if styled_palette:
        styled_by_name = {sc.get('material_name'): sc for sc in styled_palette if sc.get('material_name')}
        matched = 0
        
        for grp in unresolved_groups:
            mat_name = grp.get('material_name')
            if mat_name and mat_name in styled_by_name:
                sc = styled_by_name[mat_name]
                grp['rgba'] = sc['rgba']
                grp['transparency'] = sc['transparency']
                matched += 1
                logger.debug("[COLOR_FIX_TRY] %s: Matched group[name='%s'] to styled color", global_id, mat_name)
        
        if matched > 0:
            logger.debug("[COLOR_FIX_TRY] %s: Matched %d groups by styled color name", global_id, matched)
    
    # STRATEGY 2: Match by material association names  
    mat_colors = get_object_material_colors(obj)
    if mat_colors:
        mat_by_name = {mc.get('material_name'): mc for mc in mat_colors if mc.get('material_name')}
        matched = 0
        
        for grp in unresolved_groups:
            mat_name = grp.get('material_name')
            if mat_name and mat_name in mat_by_name:
                mc = mat_by_name[mat_name]
                col = mc.get('color', {})
                r = float(col.get('red', 0.5))
                g = float(col.get('green', 0.5))
                b = float(col.get('blue', 0.5))
                t = float(col.get('transparency', 0.0))
                a = max(0.0, min(1.0, 1.0 - t))
                grp['rgba'] = (r, g, b, a)
                grp['transparency'] = t
                matched += 1
                logger.debug("[COLOR_FIX_TRY] %s: Matched group[name='%s'] to material color", global_id, mat_name)
        
        if matched > 0:
            logger.info("[COLOR_FIX_TRY] %s: Matched %d groups by material name", global_id, matched)
    
    # STRATEGY 3: Single-material fallback
    # If we have only one material group and exactly one IFC material, apply it
    still_unresolved = [
        grp for grp in unresolved_groups 
        if is_default_material(grp.get('material_name', ''), grp['rgba'], obj_type, grp.get('transparency', 0.0))
    ]
    
    if still_unresolved and len(groups) == 1 and mat_colors and len(mat_colors) == 1:
        logger.debug("[COLOR_FIX_TRY] %s: Single-material fallback - applying only available material", global_id)
        grp = groups[0]
        mc = mat_colors[0]
        col = mc.get('color', {})
        r = float(col.get('red', 0.5))
        g = float(col.get('green', 0.5))
        b = float(col.get('blue', 0.5))
        t = float(col.get('transparency', 0.0))
        a = max(0.0, min(1.0, 1.0 - t))
        grp['rgba'] = (r, g, b, a)
        grp['transparency'] = t
        grp['material_name'] = mc.get('material_name', 'Material')
        logger.debug("[COLOR_FIX_TRY] %s: Applied single material: '%s' RGB(%.3f,%.3f,%.3f)", global_id, grp['material_name'], r, g, b)
        still_unresolved = []
    
    # Collect unresolved objects for batch logging
    if still_unresolved:
        _unresolved_objects.append(global_id)


def log_unresolved_summary() -> None:
    """Log summary of objects that remain in default gray (batch logging)."""
    if _unresolved_objects:
        count = len(_unresolved_objects)
        # Show first 20 GlobalIds for debugging
        id_list = ', '.join(_unresolved_objects[:20])
        suffix = ' ... (showing 20/%d)' % count if count > 20 else ''
        logger.warning("[COLOR_FIX_TRY] Total %d objects without color, in default gray. GlobalIds: %s%s", count, id_list, suffix)
    _unresolved_objects.clear()


__all__ = [
    'build_style_and_colour_indexes',
    'collect_styled_colors_from_obj',
    'get_object_material_colors',
    'extract_color_from_material',
    'resolve_colors_for_groups',
    'log_unresolved_summary',
    'is_default_material',
    'clear_color_cache',
]



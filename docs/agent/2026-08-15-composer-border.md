# Composer border layout

The composer frame previously took its width from its children. A long input line or an embedded newline could therefore occupy the terminal's final column, where Ink was also trying to draw the right border. The visible result was an interrupted or displaced right edge.

The frame now spans its available width and uses a separate, shrinkable content row. The editor wraps inside that row instead of competing with the border column. Keeping the frame and its content as separate layout boxes also makes multiline input behave consistently when the terminal is resized.

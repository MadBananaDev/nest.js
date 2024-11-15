#!/bin/bash
# directory_tree.sh - Generate a directory tree

usage() {
    echo "Usage: $0 -d <directory> [-L <max_depth>] [-P <pattern>] [-I <ignore_pattern>]"
    echo "  -d: Directory to generate tree for"
    echo "  -L: Maximum depth of the tree (default: unlimited)"
    echo "  -P: Show only files that match the pattern"
    echo "  -I: Do not list files that match the pattern"
    exit 1
}

generate_tree() {
    local tree_args=""
    [ -n "$max_depth" ] && tree_args+=" -L $max_depth"
    [ -n "$pattern" ] && tree_args+=" -P $pattern"
    [ -n "$ignore_pattern" ] && tree_args+=" -I $ignore_pattern"

    tree $tree_args "$directory"
}

while getopts ":d:L:P:I:" opt; do
    case $opt in
        d) directory="$OPTARG" ;;
        L) max_depth="$OPTARG" ;;
        P) pattern="$OPTARG" ;;
        I) ignore_pattern="$OPTARG" ;;
        \?) usage ;;